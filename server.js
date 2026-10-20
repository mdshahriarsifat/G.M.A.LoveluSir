const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

app.post('/webhook', async (req, res) => {
  try {
    const msg = req.body.message || req.body.channel_post;
    if (!msg) return res.sendStatus(200);

    // Clean invisible carriage returns (\r) sent by Telegram/mobile keyboards
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

    // 2. EXTRACT AND PARSE ALL CLASS BLOCKS
    const blocks = rawText.split(/(?=Year:\s*)/i);

    const snapshot = await db.collection('classes').get();
    const existingClassesMap = new Map();
    snapshot.forEach(doc => {
      if (doc.data().title) {
        existingClassesMap.set(doc.data().title.trim().toLowerCase(), doc);
      }
    });

    for (const block of blocks) {
      if (!block.trim()) continue;

      const titleMatch = block.match(/Title:\s*([^\n]+)/i);
      const yearMatch = block.match(/Year:\s*([^\n]+)/i);
      const subjectMatch = block.match(/Subject:\s*([^\n]+)/i);
      const linkMatch = block.match(/Link:\s*(https?:\/\/[^\s\n]+)/i);
      const pdfMatch = block.match(/PDF:\s*(https?:\/\/[^\s\n]+)/i);
      const dateMatch = block.match(/Uploaded\s*date:\s*([^\n]+)/i);

      if (titleMatch && linkMatch) {
        const rawTitle = titleMatch[1].trim();
        const normalizedTitle = rawTitle.toLowerCase();
        const existingDoc = existingClassesMap.get(normalizedTitle);

        // Normalize year string (Freshmen -> Freshman)
        let extractedYear = yearMatch ? yearMatch[1].trim() : "Sophomore";
        if (extractedYear.toLowerCase().includes("freshm")) extractedYear = "Freshman";

        let classDate = new Date().toISOString();
        if (dateMatch) {
          const cleanDateStr = dateMatch[1].trim();
          const parsed = Date.parse(cleanDateStr);
          if (!isNaN(parsed)) {
            classDate = new Date(parsed).toISOString();
          }
        }

        if (existingDoc) {
          // UPDATE EXISTING CLASS
          const updateData = {};
          if (yearMatch) updateData.year = extractedYear;
          if (subjectMatch) updateData.subject = subjectMatch[1].trim();
          if (linkMatch) updateData.url = linkMatch[1].trim();
          if (pdfMatch) updateData.pdfUrl = pdfMatch[1].trim();
          if (dateMatch) updateData.date = classDate;

          await existingDoc.ref.update(updateData);
          console.log(`Updated class record: ${rawTitle}`);
        } else {
          // CREATE NEW CLASS
          const url = linkMatch[1].trim();
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
          existingClassesMap.set(normalizedTitle, { ref: docRef });
          console.log(`Created new class: ${rawTitle}`);
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
