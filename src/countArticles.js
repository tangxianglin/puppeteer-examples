const path = require('path')
const fs = require('fs')
const puppeteer = require('puppeteer')
const moment = require('moment')

// 页面加载参数
const pageOptions = {
  timeout: 0,
  waitUntil: [
    'domcontentloaded',
    'networkidle0'
  ]
}

async function delay (times = 0) {
  return new Promise(resolve => {
    setTimeout(() => resolve(), times)
  })
}

function output (data, pathname) {
  fs.writeFileSync(
    path.resolve(__dirname, pathname),
    JSON.stringify(data)
  )
}

async function safeFunc (func) {
  try {
    const res = await func()
    return [null, res]
  } catch (e) {
    return [e, null]
  }
}

(async function collect () {
  const browser = await puppeteer.launch({
    headless: false
    // args: ['--no-sandbox']
  })

  const topics = await getTopics(browser)

  // 到每个专题下获取文章
  const page = await browser.newPage()
  for (const topic of topics) {
    await page.goto(topic.topicHome, pageOptions)
    const articles = await getArticles(page)
    Object.assign(topic, {
      articles: articles.map(one => ({ ...topic, ...one }))
    })
  }

  // 对专题中的文章按作者分类
  const authors = topics.reduce((acc, topic) => {
    topic.articles.forEach(article => {
      const { authorName, authorHome } = article
      const exsitAuthor = acc.find(one => one.authorHome === authorHome)
      if (exsitAuthor) {
        Object.assign(exsitAuthor, { articles: [...exsitAuthor.articles, article] })
      } else {
        acc.push({ authorName, authorHome, articles: [article] })
      }
    })
    return acc
  }, [])

  // 从用户首页补全文章的阅读量和发布时间
  for (const author of authors) {
    const { authorHome, articles } = author
    await page.goto(authorHome, pageOptions)
    const authorAllArticles = await getArticlesDetail(page)
    articles.forEach(article => {
      const articleExtraInfo = authorAllArticles.find(one => article.url === one.url)
      Object.assign(article, articleExtraInfo)
    })
  }

  // 纵横研究院所有文章
  const allArticles = authors.reduce((acc, current) => acc.concat(current.articles), [])

  const allReadCount = allArticles.reduce((acc, current) => (acc + current.readCount), 0)

  output({
    articleCount: allArticles.length,
    readCount: allReadCount,
    articles: allArticles.sort((a, b) => (b.readCount - a.readCount))
  }, './纵横研究院文章列表.json')

  // 专题文章信息补全
  topics.forEach(one => {
    one.articles.forEach(article => {
      const articleExtraInfo = allArticles.find(one => article.url === one.url)
      Object.assign(article, articleExtraInfo)
    })
  })

  output({
    articleCount: allArticles.length,
    readCount: allReadCount,
    topicCount: topics.length,
    topics: topics
      .sort((a, b) => (b.articles.length - a.articles.length))
      .map(one => ({
        articleCount: one.articles.length,
        readCount: one.articles.reduce((acc, current) => (acc + current.readCount), 0),
        ...one,
        articles: one.articles.sort((a, b) => (b.readCount - a.readCount))
      }))
  }, './纵横研究院专题统计.json')

  output({
    articleCount: allArticles.length,
    readCount: allReadCount,
    authorCount: authors.length,
    authors: authors
      .sort((a, b) => (b.articles.length - a.articles.length))
      .map(one => ({
        articleCount: one.articles.length,
        readCount: one.articles.reduce((acc, current) => (acc + current.readCount), 0),
        ...one,
        articles: one.articles.sort((a, b) => (b.readCount - a.readCount))
      }))
  }, './纵横研究院作者统计.json')

  await browser.close()
})()

/**
 * 从 https://www.jianshu.com/u/9b797d42a0cc 页面获取纵横研究院所有专题
 */
async function getTopics (browser) {
  const page = await browser.newPage()
  await page.goto('https://www.jianshu.com/u/9b797d42a0cc', pageOptions)
  await safeFunc(async () => {
    await page.click('.list .check-more')
    await delay(1000)
  })

  const res = await page.evaluate(async () => {
    const titleDom = Array.from(document.querySelectorAll('.title'))
      .find(one => one.innerText === '他创建的专题')
    if (!titleDom) return []
    return Array.from(titleDom.nextElementSibling.querySelectorAll('li'))
      .reduce((acc, current) => {
        const item = current.querySelector('.name')
        if (!item) return acc
        return acc.concat({
          topicName: item.innerText,
          topicHome: item.href
        })
      }, [])
  })
  await page.close()
  return res
}

/**
 * 简书的列表为懒加载，自动滚动到底部以加载所有数据
 */
async function autoScroll (page) {
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      let totalHeight = 0
      let distance = 100
      let timer = setInterval(() => {
        let scrollHeight = document.body.scrollHeight
        window.scrollBy(0, distance)
        totalHeight += distance
        if (totalHeight >= scrollHeight) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })
  })
}

/**
 * 从专题页面获取所有的文章
 */
async function getArticles (page) {
  await autoScroll(page)
  const articles = await page.evaluate(async () => {
    return Array.from(document.querySelectorAll('.note-list > li'))
      .reduce((acc, current) => {
        const titleDom = current.querySelector('.title')
        const nicknameDom = current.querySelector('.nickname')
        if (!titleDom || !nicknameDom) return acc

        const starIcon = nicknameDom.parentElement.querySelector('.ic-list-like')
        const stars = (starIcon && Number.parseInt(starIcon.nextSibling.data)) || 0
        const commentIcon = nicknameDom.parentElement.querySelector('.ic-list-comments')
        const comments = (commentIcon && Number.parseInt(commentIcon.nextSibling.data)) || 0
        return acc.concat({
          authorName: nicknameDom.innerText,
          authorHome: nicknameDom.href,
          title: titleDom.innerText,
          url: titleDom.href,
          stars,
          comments
        })
      }, [])
  })
  return articles
}

/**
 * 从用户页面获取文章的详细信息，包括阅读量、发布时间
 */
async function getArticlesDetail (page) {
  await autoScroll(page)
  const articles = await page.evaluate(async () => {
    return Array.from(document.querySelectorAll('.note-list > li')).map(one => {
      if (!one) return {}
      const titleDom = one.querySelector('.title')
      const url = titleDom && titleDom.href
      const readIcon = one.querySelector('.ic-list-read')
      const readCount = (readIcon && Number.parseInt(readIcon.nextSibling.data)) || 0
      const timeDom = one.querySelector('.time')
      const publishTime = timeDom && moment(timeDom.dataset.sharedAt).format('YYYY-MM-DD HH:mm')
      return { url, readCount, publishTime }
    })
  })
  return articles
}

// async function execTasks (browser, tasks, maxPageCount = 10) {
//   const taskStatus = new Array(tasks.length).fill(0)
//   await Promise.all(Array.from({ length: maxPageCount }).map(async (one, i) => {
//     await delay(i * 500)
//     const page = await browser.newPage()
//     while (true) {
//       const index = findIndex(taskStatus, status => !status)
//       if (index === -1) break
//       taskStatus[index] = 1
//       await tasks[index](page)
//     }
//   }))
// }

// const topics = await getTopics(browser)
// await execTasks(browser, topics.map(topic => async (page) => {
//   await page.goto(topic.topicHome, pageOptions)
//   const articles = await getArticles(page)
//   Object.assign(topic, {
//     articles: articles.map(one => ({ ...topic, ...one }))
//   })
// }))
