const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

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
    
    snapshot.docChanges().forEach(() => {}); // compatibility
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.title && data.url) {
        // Create a unique composite key: "title|url" to allow same titles with different video links
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
          const cleanDateStr = dateMatch.id || dateMatch[1].trim();
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
