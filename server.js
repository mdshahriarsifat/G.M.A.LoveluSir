const express = require('express');
const admin = require('firebase-admin');
const Parser = require('rss-parser');
const parser = new Parser();
const cron = require('node-cron');

const app = express();
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

// --- HELPER TO SEND FORMATTED MESSAGE TO TELEGRAM ---
async function sendToTelegramChannel(classData) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const messageText = `Year: ${classData.year}
Subject: ${classData.subject}
Title: ${classData.title}
Link: ${classData.url}
Uploaded date: ${classData.date.split('T')[0]}`;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText
      })
    });
    console.log("Auto-sent parsed class format to Telegram channel.");
  } catch (err) {
    console.error("Failed to send message to Telegram:", err);
  }
}

// --- GEMINI AI THUMBNAIL ANALYSIS & SMART VERIFICATION ---
async function analyzeThumbnailWithGemini(thumbnailUrl, fallbackTitle) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { title: fallbackTitle, subject: "General", year: "Sophomore" };
  }

  try {
    const imageResponse = await fetch(thumbnailUrl);
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString("base64");

    const prompt = `Analyze this video thumbnail image and the fallback title provided ("${fallbackTitle}"). 
    Extract and strictly verify academic class details. Ensure title and subject are separated clearly and never repeated, mixed up, or left blank. 
    Return a strictly formatted JSON object with no markdown formatting (no \`\`\`json):
    {
      "title": "Clean, distinct lecture title only",
      "subject": "Exact academic subject name like Numerical Methods, Linear Algebra, Ordinary Differential Equations, Calculus-2, Abstract Algebra, etc.",
      "year": "Academic year: must be strictly one of [Freshman, Sophomore, Junior, Senior]"
    }
    Rules: 
    1. Never duplicate the same text into both title and subject.
    2. If year is missing or ambiguous, default to Sophomore.`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: "image/jpeg",
                  data: base64Image
                }
              }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    const textResult = data.candidates[0].content.parts[0].text.trim();
    const cleanJSON = textResult.replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(cleanJSON);
  } catch (err) {
    console.error("Gemini thumbnail analysis error:", err);
    return { title: fallbackTitle, subject: "General", year: "Sophomore" };
  }
}

// --- YOUTUBE RSS AUTO-POLLING (RUNS ONCE EVERY 24 HOURS) ---
const YOUTUBE_CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;

async function checkNewYouTubeVideos() {
  if (!YOUTUBE_CHANNEL_ID) {
    console.log("YOUTUBE_CHANNEL_ID not set in environment variables. Skipping auto-check.");
    return;
  }

  try {
    console.log("Running 24-hour scheduled check for new YouTube videos...");
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${YOUTUBE_CHANNEL_ID}`;
    const feed = await parser.parseURL(feedUrl);
    
    const snapshot = await db.collection('classes').get();
    const existingUrls = new Set();
    snapshot.forEach(doc => {
      if (doc.data().url) existingUrls.add(doc.data().url.trim());
    });

    for (const item of feed.items) {
      const videoId = item.id.replace('yt:video:', '');
      const videoLink = item.link;
      const rawTitle = item.title;
      const pubDate = item.isoDate || new Date().toISOString();

      if (existingUrls.has(videoLink)) {
        continue;
      }

      console.log(`New YouTube video found: ${rawTitle}. Analyzing thumbnail via Gemini AI...`);
      const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
      
      const parsedData = await analyzeThumbnailWithGemini(thumbnailUrl, rawTitle);

      let extractedYear = parsedData.year || "Sophomore";
      if (extractedYear.toLowerCase().includes("freshm")) extractedYear = "Freshman";

      const classData = {
        title: parsedData.title || rawTitle,
        year: extractedYear,
        subject: parsedData.subject || "General",
        url: videoLink,
        pdfUrl: null,
        views: 0,
        date: pubDate,
        videoType: 'youtube'
      };

      await db.collection('classes').add(classData);
      console.log(`[Auto-Sync Success] Saved to Firebase: ${classData.title} | Subject: ${classData.subject}`);

      // Forward formatted message to Telegram channel automatically
      await sendToTelegramChannel(classData);
    }
  } catch (error) {
    console.error("Error in YouTube auto-polling:", error);
  }
}

// Schedule cron job to run ONCE EVERY 24 HOURS (at midnight: 0 0 * * *)
cron.schedule('0 0 * * *', () => {
  checkNewYouTubeVideos();
});

app.post('/webhook', async (req, res) => {
  try {
    const msg = req.body.message || req.body.channel_post;
    if (!msg) return res.sendStatus(200);

    const rawText = (msg.text || msg.caption || '').replace(/\r/g, '');

    // 1. DELETE CLASS COMMAND
    const deleteMatch = rawText.match(/Delete:\s*(.+)/i);
    if (deleteMatch) {
      const targetTitle = deleteMatch[1].trim().toLowerCase();
      const snapshot = await db.collection('classes').get();
      snapshot.forEach(async (doc) => {
        if (doc.data().title && doc.data().title.trim().toLowerCase() === targetTitle) {
          await doc.ref.delete();
          console.log(`Deleted class: ${doc.data().title}`);
        }
      });
      return res.sendStatus(200);
    }

    // 2. ROBUST SPLIT FOR MULTI-CLASS POSTS
    const blocks = rawText.split(/(?:\n\s*)*\bYear:\s*/i);

    const snapshot = await db.collection('classes').get();
    const existingClassesMap = new Map();
    
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.title && data.url) {
        const uniqueKey = `${data.title.trim().toLowerCase()}|${data.url.trim()}`;
        existingClassesMap.set(uniqueKey, doc);
      }
    });

    for (const block of blocks) {
      if (!block.trim()) continue;

      const fullBlock = "Year: " + block;

      const titleMatch = fullBlock.match(/Title:\s*([^\n]+)/i);
      const yearMatch = fullBlock.match(/Year:\s*([^\n]+)/i);
      const subjectMatch = fullBlock.match(/Subject:\s*([^\n]+)/i);
      const linkMatch = fullBlock.match(/Link:\s*(https?:\/\/[^\s\n]+)/i);
      const pdfMatch = fullBlock.match(/PDF:\s*(https?:\/\/[^\s\n]+)/i);
      const dateMatch = fullBlock.match(/Uploaded\s*date:\s*([^\n]+)/i);

      if (titleMatch && linkMatch) {
        const rawTitle = titleMatch[1].trim();
        const url = linkMatch[1].trim();
        const uniqueKey = `${rawTitle.toLowerCase()}|${url}`;
        const existingDoc = existingClassesMap.get(uniqueKey);

        let extractedYear = yearMatch ? yearMatch[1].trim() : "Sophomore";
        if (extractedYear.toLowerCase().includes("freshm")) extractedYear = "Freshman";

        let classDate = new Date().toISOString();
        if (dateMatch) {
          const parsed = Date.parse(dateMatch[1].trim());
          if (!isNaN(parsed)) {
            classDate = new Date(parsed).toISOString();
          }
        }

        if (existingDoc) {
          // UPDATE EXISTING CLASS
          const updateData = {};
          if (yearMatch) updateData.year = extractedYear;
          if (subjectMatch) updateData.subject = subjectMatch[1].trim();
          if (pdfMatch) updateData.pdfUrl = pdfMatch[1].trim();
          if (dateMatch) updateData.date = classDate;

          await existingDoc.ref.update(updateData);
          console.log(`Updated class record: ${rawTitle}`);
        } else {
          // CREATE NEW CLASS (Guarantees unique storage per video link)
          const classData = {
            title: rawTitle,
            year: extractedYear,
            subject: subjectMatch ? subjectMatch[1].trim() : "General",
            url: url,
            pdfUrl: pdfMatch ? pdfMatch[1].trim() : null,
            views: 0,
            date: classDate,
            videoType: url.includes('facebook.com') ? 
                       (url.includes('/groups/') ? 'facebook_private' : 'facebook_public') 
                       : 'youtube'
          };
          
          const docRef = await db.collection('classes').add(classData);
          existingClassesMap.set(uniqueKey, { ref: docRef });
          console.log(`Created new class: ${rawTitle} (${url})`);
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
