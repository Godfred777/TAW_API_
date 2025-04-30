// services/socialService.js
import fetch from 'node-fetch';
import { analyzeSentiment, analyzeEntities } from '../utils/analysis.js';
import { getUniqueKey } from '../utils/helpers.js';
import { detectLanguage } from '../utils/languages/languageDetection.js';
import admin from '../configuration/firebase.js';
const db = admin.firestore();
import config from '../configuration/config.js';

/**
 * Fetches popular social media posts based on popular hashtags.
 * Excludes retweets, requests media expansions, and extracts image URLs.
 * @return {Promise<Object[]>} A promise that resolves to an array of social media post objects.
 */
export async function fetchPopularSocialPosts() {
  // Define an array of popular hashtags (without the '#' symbol)
  const popularHashtags = [
    'news',
    'tech',
    'sports',
    'entertainment',
    'politics',
  ];

  // Construct the query string: e.g. "#news OR #tech OR #sports OR #entertainment OR #politics"
  const query = popularHashtags
    .map((tag) => `#${tag}`)
    .join(' OR ');

  console.log('Constructed hashtag query:', query);

  const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&tweet.fields=public_metrics,entities,attachments&expansions=attachments.media_keys&media.fields=url`;
  const options = {
    headers: {
      'Authorization': `Bearer ${config.TWITTER_BEARER_TOKEN}`,
    },
  };

  try {
    const response = await fetch(url, options);
    const data = await response.json();
    console.log('Twitter API response for hashtags:', data);

    // Check if the API reports a usage cap or error
    if (data.title === 'UsageCapExceeded') {
      console.error('Usage cap exceeded for hashtag query');
      return [];
    }

    // Build a media map from media_key to media URL (if available)
    const mediaMap = {};
    if (data.includes && data.includes.media) {
      for (const media of data.includes.media) {
        mediaMap[media.media_key] = media.url;
      }
    }

    if (data && Array.isArray(data.data)) {
      const tweets = data.data
        .map((tweet) => {
          if (tweet.attachments && tweet.attachments.media_keys && tweet.attachments.media_keys.length > 0) {
            tweet.imageUrl = mediaMap[tweet.attachments.media_keys[0]] || null;
          } else {
            tweet.imageUrl = null;
          }
          return tweet;
        })
        .filter((tweet) => {
          const metrics = tweet.public_metrics || {};
          const popularByRetweets = metrics.retweet_count && metrics.retweet_count > 5;
          const popularByLikes = metrics.like_count && metrics.like_count > 50;
          const hasEntities = tweet.entities && Object.keys(tweet.entities).length > 0;
          return popularByRetweets || popularByLikes || hasEntities;
        });
      return tweets;
    } else {
      console.error('Unexpected response format:', data);
      return [];
    }
  } catch (err) {
    console.error('Error fetching social media posts:', err.message);
    return [];
  }
}

/**
 * Processes and stores fetched social posts in Firestore.
 * @return {Promise<Object>} Result with message and count.
 */
export async function processAndStoreSocialPosts() {
  const posts = await fetchPopularSocialPosts();
  console.log('Number of social posts to ingest:', posts.length);
  let batch = db.batch();
  const MAX_BATCH_SIZE = 500;
  let operationCount = 0;

  for (const post of posts) {
    const contentForAnalysis = post.text || '';
    const sentiment = analyzeSentiment(contentForAnalysis);
    let entities = {};
    try {
      entities = await analyzeEntities(contentForAnalysis);
    } catch (e) {
      console.error('Entity analysis failed for social post:', e);
    }
    let geoLocation = null;
    if (post.geo && post.geo.coordinates) {
      geoLocation = {
        lat: post.geo.coordinates.latitude,
        lng: post.geo.coordinates.longitude,
      };
    } else if (entities.places && entities.places.length > 0) {
      geoLocation = entities.places[0];
    }

    // Detect the original language of the the tweet
    const sourceLanguage = detectLanguage(contentForAnalysis);

    const uniqueKey = getUniqueKey(post.id, post.text);
    console.log('Generated unique key for post:', uniqueKey);
    const docData = {
      title: '',
      link: `https://twitter.com/i/web/status/${post.id}`,
      pubDate: new Date().toISOString(),
      source: 'Twitter',
      sentiment,
      entities,
      location: geoLocation,
      description: contentForAnalysis,
      language: sourceLanguage,
      imageUrl: post.imageUrl,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      publicMetrics: post.public_metrics,
    };
    const docRef = db.collection('social_posts').doc(uniqueKey);
    batch.set(docRef, docData, {merge: true});
    operationCount++;
    if (operationCount >= MAX_BATCH_SIZE) {
      await batch.commit();
      console.log('Committed a batch of social posts, count:', operationCount);
      batch = db.batch();
      operationCount = 0;
    }
  }
  if (operationCount > 0) {
    await batch.commit();
    console.log('Final batch commit executed for social posts, remaining count:', operationCount);
  }
  return {message: 'Social media posts ingested successfully', count: posts.length};
}
