// routes/articles.js
import { Router } from 'express';
// eslint-disable-next-line new-cap
const router = Router();
import admin from 'firebase-admin';
import checkApiKey from '../utils/auth.js';
import { fetchAndStoreRssFeeds } from '../services/rssService.js';
import { translateAndStoreArticles } from '../services/translationService.js';
import { rewriteAndStoreArticles } from '../services/rewritingService.js';
import nlp from 'compromise';
import { FieldPath } from 'firebase-admin/firestore';
// Apply the API key middleware to these routes.
router.use('/articles', checkApiKey);
router.use('/rss', checkApiKey);
router.use('/articles/:category', checkApiKey);
router.use('/search', checkApiKey);
router.use('/related', checkApiKey);
router.use('/translate', checkApiKey);
router.use('/rewrite', checkApiKey);
router.use('/french/articles', checkApiKey);
router.use('/swahili/articles', checkApiKey);
router.use('/spanish/articles', checkApiKey);
router.use('/german/articles', checkApiKey);



// GET /rss - Process RSS feeds and store them
router.get('/rss', async (req, res) => {
  try {
    const result = await fetchAndStoreRssFeeds();
    res.set('Cache-Control', 'public, max-age=30');
    res.json(result);
  } catch (error) {
    console.error('Error in /rss endpoint:', error);
    res.status(500).json({error: 'Failed to fetch and store RSS feeds'});
  }
});

// GET /translate - Translate articles to different languages
router.get('/translate', async (req, res) => {
  try {
    await translateAndStoreArticles();
    res.set('Cache-Control', 'public, max-age=30');
    res.json({message: 'Translation process completed'});
  } catch (error) {
    console.error('Error in /translate endpoint:', error);
    res.status(500).json({error: 'Failed to start translation process'});
  }
});

// GET /rewrite - Rewrite articles in different languages
router.get('/rewrite', async (req, res) => {
  try {
    await rewriteAndStoreArticles();
    res.set('Cache-Control', 'public, max-age=30');
    res.json({message: 'Rewriting process completed'});
  } catch (error) {
    console.error('Error in /rewrite endpoint:', error);
    res.status(500).json({error: 'Failed to start rewriting process'});
  }
});

// GET /articles - Retrieve all articles
router.get('/articles', async (req, res) => {
  const db = admin.firestore();

  // Read pagination params (with defaults)
  const pageSize  = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10));
  const pageToken = req.query.pageToken; 

  try {
    // Build base query: order by timestamp and document ID for tiebreaker
    let query = db
      .collectionGroup('articles')
      .orderBy('createdAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(pageSize);

    if (pageToken) {
      const lastDocSnap = await db.doc(pageToken).get();
      if (lastDocSnap.exists) {
        query = query.startAfter(lastDocSnap);
      } else {
        return res.status(400).json({ error: 'Invalid pageToken' });
      }
    }

    const snapshot = await query.get();
    const articles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    let nextPageToken = null;
    if (snapshot.docs.length === pageSize) {
      nextPageToken = snapshot.docs[pageSize - 1].ref.path;
    }

    res.json({ articles, nextPageToken });
  } catch (error) {
    console.error('Error retrieving paginated articles:', error);
    res.status(500).json({ error: 'Failed to retrieve articles' });
  }
});
// GET /articles/:category - Retrieve articles by category
router.get('/articles/:category', async (req, res) => {
  const db = admin.firestore();
  try {
    let {category} = req.params;
    category = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
    const snapshot = await db.collection('rss_articles').doc(category).collection('articles').orderBy('createdAt', 'desc').get();
    const articles = snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
    res.json(articles);
  } catch (error) {
    console.error(`Error retrieving articles for category ${req.params.category}:`, error);
    res.status(500).json({error: 'Failed to retrieve articles by category'});
  }
});

// GET /search - Search articles by keyword
router.get('/search', async (req, res) => {
  const db = admin.firestore();
  try {
    const keywords = Object.values(req.query).map((kw) => kw.toLowerCase()).filter(Boolean);
    if (keywords.length === 0) {
      return res.status(400).json({error: 'Missing query parameter. Provide at least one keyword.'});
    }
    const snapshot = await db.collectionGroup('articles').get();
    if (snapshot.empty) {
      return res.status(404).json({error: 'No articles found.'});
    }
    const articles = snapshot.docs.map((doc) => ({id: doc.id, ...doc.data()}));
    const filteredArticles = articles.filter((article) => {
      const text = ((article.title || '') + ' ' + (article.link || '') + ' ' + (article.source || '') + ' ' + (article.category || '') + ' ' + (article.sentiment || '')).toLowerCase();
      return keywords.some((keyword) => text.includes(keyword));
    });
    if (filteredArticles.length === 0) {
      return res.status(404).json({error: 'No matching articles found.'});
    }
    res.json(filteredArticles);
  } catch (error) {
    console.error('Error searching for articles:', error);
    res.status(500).json({error: 'Failed to search for articles'});
  }
});

// GET /related - Fetch related articles based on an article title
router.get('/related', async (req, res) => {
  const db = admin.firestore();
  try {
    const {title} = req.query;
    if (!title) return res.status(400).json({error: 'Missing \'title\' query parameter.'});
    const originalSnap = await db.collectionGroup('articles').where('title', '==', title).get();
    if (originalSnap.empty) return res.status(404).json({error: 'Original article not found.'});
    const originalDoc = originalSnap.docs[0];
    const originalArticle = originalDoc.data();
    const textForKeywords = originalArticle.description || originalArticle.title || '';
    const doc = nlp(textForKeywords);
    let keywords = doc.nouns().out('array');
    keywords = [...new Set(keywords.map((word) => word.toLowerCase()).filter((word) => word.length > 3))];
    const snapshotAll = await db.collectionGroup('articles').get();
    if (snapshotAll.empty) return res.status(404).json({error: 'No articles found.'});
    let articles = snapshotAll.docs.map((doc) => ({id: doc.id, ...doc.data()}));
    articles = articles.filter((article) => article.title !== title);
    const relatedArticles = articles.filter((article) => {
      const text = ((article.title || '') + ' ' + (article.description || '')).toLowerCase();
      return keywords.some((keyword) => text.includes(keyword));
    });
    const originalDate = new Date(originalArticle.pubDate);
    const historicalArticles = articles
      .filter((article) => new Date(article.pubDate) < originalDate)
      .sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
    res.json({
      originalArticle,
      relatedArticles,
      historicalArticles,
    });
  } catch (error) {
    console.error('Error fetching related articles:', error);
    res.status(500).json({error: 'Failed to fetch related articles'});
  }
});

// GET /articles/french - Fetching articles translated to French
router.get('/french/articles', async (req, res) => {
  const db = admin.firestore();
  
  // Read pagination params (with defaults)
  const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10));
  const pageToken = req.query.pageToken;

  try {
    // Build base query
    let query = db.collectionGroup('fr')
      .orderBy('translatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(pageSize);

    // Apply pagination token if provided
    if (pageToken) {
      const lastDocSnap = await db.doc(pageToken).get();
      if (lastDocSnap.exists) {
        query = query.startAfter(lastDocSnap);
      } else {
        return res.status(400).json({ error: 'Invalid pageToken' });
      }
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No French translations found' });
    }

    const frenchArticles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Get next page token if there are more results
    let nextPageToken = null;
    if (snapshot.docs.length === pageSize) {
      nextPageToken = snapshot.docs[pageSize - 1].ref.path;
    }

    res.status(200).json({ articles: frenchArticles, nextPageToken });
  } catch (error) {
    console.error('Error getting French articles:', error);
    res.status(500).json({ error: 'Failed to retrieve French articles' });
  }
});

// GET /articles/swahili - Fetching articles translated to Swahili
router.get('/swahili/articles', async (req, res) => {
  const db = admin.firestore();
  
  // Read pagination params (with defaults)
  const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10));
  const pageToken = req.query.pageToken;

  try {
    // Build base query
    let query = db.collectionGroup('sw')
      .orderBy('translatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(pageSize);

    // Apply pagination token if provided
    if (pageToken) {
      const lastDocSnap = await db.doc(pageToken).get();
      if (lastDocSnap.exists) {
        query = query.startAfter(lastDocSnap);
      } else {
        return res.status(400).json({ error: 'Invalid pageToken' });
      }
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No Swahili translations found' });
    }

    const swahiliArticles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Get next page token if there are more results
    let nextPageToken = null;
    if (snapshot.docs.length === pageSize) {
      nextPageToken = snapshot.docs[pageSize - 1].ref.path;
    }

    res.status(200).json({ articles: swahiliArticles, nextPageToken });
  } catch (error) {
    console.error('Error getting Swahili articles:', error);
    res.status(500).json({ error: 'Failed to retrieve Swahili articles' });
  }
});

// GET /articles/spanish - Fetching articles translated to Spanish
router.get('/spanish/articles', async (req, res) => {
  const db = admin.firestore();
  
  // Read pagination params (with defaults)
  const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10));
  const pageToken = req.query.pageToken;

  try {
    // Build base query
    let query = db.collectionGroup('es')
      .orderBy('translatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(pageSize);

    // Apply pagination token if provided
    if (pageToken) {
      const lastDocSnap = await db.doc(pageToken).get();
      if (lastDocSnap.exists) {
        query = query.startAfter(lastDocSnap);
      } else {
        return res.status(400).json({ error: 'Invalid pageToken' });
      }
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No Spanish translations found' });
    }

    const spanishArticles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Get next page token if there are more results
    let nextPageToken = null;
    if (snapshot.docs.length === pageSize) {
      nextPageToken = snapshot.docs[pageSize - 1].ref.path;
    }

    res.status(200).json({ articles: spanishArticles, nextPageToken });
  } catch (error) {
    console.error('Error getting Spanish articles:', error);
    res.status(500).json({ error: 'Failed to retrieve Spanish articles' });
  }
});

// GET /articles/german - Fetching articles translated to German
router.get('/german/articles', async (req, res) => {
  const db = admin.firestore();
  
  // Read pagination params (with defaults)
  const pageSize = Math.max(1, Math.min(100, parseInt(req.query.pageSize, 10) || 10));
  const pageToken = req.query.pageToken;

  try {
    // Build base query
    let query = db.collectionGroup('de')
      .orderBy('translatedAt', 'desc')
      .orderBy(FieldPath.documentId(), 'desc')
      .limit(pageSize);

    // Apply pagination token if provided
    if (pageToken) {
      const lastDocSnap = await db.doc(pageToken).get();
      if (lastDocSnap.exists) {
        query = query.startAfter(lastDocSnap);
      } else {
        return res.status(400).json({ error: 'Invalid pageToken' });
      }
    }

    const snapshot = await query.get();

    if (snapshot.empty) {
      return res.status(404).json({ message: 'No German translations found' });
    }

    const germanArticles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Get next page token if there are more results
    let nextPageToken = null;
    if (snapshot.docs.length === pageSize) {
      nextPageToken = snapshot.docs[pageSize - 1].ref.path;
    }

    res.status(200).json({ articles: germanArticles, nextPageToken });
  } catch (error) {
    console.error('Error getting German articles:', error);
    res.status(500).json({ error: 'Failed to retrieve German articles' });
  }
});


export default router;
