import admin from '../configuration/firebase.js';
import { queueRewriting } from '../utils/article-rewriting/queueRewriting.js';

const db = admin.firestore();

const DEFAULT_LIMIT = 5;
const DELAY_MS = 2000;
const DelayNode = () => new Promise(resolve => setTimeout(resolve, DELAY_MS));

const TARGET_LANGUAGES = ['en', 'sw'];

export async function rewriteAndStoreArticles() {
  try {
    const articlesRef = db.collectionGroup('articles');
    const snapshot = await articlesRef.limit(DEFAULT_LIMIT).get();

    if (snapshot.empty) {
      console.log('No articles found to rewrite');
      return;
    }

    for (const doc of snapshot.docs) {
      const article = doc.data();
      const articleId = doc.id;

      for (const targetLang of TARGET_LANGUAGES) {
        await DelayNode();
        // Create reference to language-specific subcollection
        const rewriteID = `${articleId}-${targetLang}`;
        const rewritingRef = db.collection('rewrites')
          .doc(targetLang)
          .collection('articles')
          .doc(rewriteID);
                
        const rewritingDoc = await rewritingRef.get();

        if (!rewritingDoc.exists) {
          const rewrittenArticle = await queueRewriting(
            article,
            targetLang
          ).catch((error) => {
            if (error.status === 401 || error.status === 403) {
              console.log(`Skipping article ${articleId}`);
              return null;
            }
          });

          if (!rewrittenArticle) {
            console.error(`Failed to rewrite article ${articleId} to ${targetLang}`);
            continue;
          }

          await rewritingRef.set({
            ...rewrittenArticle,
            originalArticleId: articleId,
            originalCollectionPath: doc.ref.path,
            language: targetLang,
            rewrittenAt: admin.firestore.FieldValue.serverTimestamp(),
            source: article.source || null,
          });
          console.log(`Article ${articleId} rewritten to ${targetLang}`);
        }
      }
    }
  } catch (error) {
    console.error('Error in rewriteAndStoreArticles:', error);
  }
  console.log('Rewriting process completed successfully.');
}