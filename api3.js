const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { google } = require('googleapis');
const multer = require('multer');
const fs = require('fs');

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(cors({
  origin: '*', // Allow all origins (adjust for production)
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Load Firebase Service Account Key
const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
const serviceAccount = require(serviceAccountPath);

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://world-6eb53.firebaseio.com" // Your Firebase project URL
});

const db = admin.firestore();

// Configure Multer for file uploads
const upload = multer({
  dest: 'uploads/', // Temporary storage folder
  limits: { fileSize: 1000 * 1024 * 1024 }, // 1GB limit (adjust as needed)
});

// Google Drive Setup (Service Account)
const driveServiceAccountPath = path.join(__dirname, 'apikey.json');
const driveAuth = new google.auth.GoogleAuth({
  keyFile: driveServiceAccountPath,
  scopes: ['https://www.googleapis.com/auth/drive.file'],
});
const drive = google.drive({ version: 'v3', auth: driveAuth });

// Basic route (for testing)
app.get('/', (req, res) => {
  res.send('API is running');
});

// Sign-Up Endpoint
app.post('/signup', async (req, res) => {
  const { email, password, income, location, working_status, interests, name, about } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: 'Email, password, and name are required' });
  }
  if (!income || !location || !working_status || !interests || !about) {
    return res.status(400).json({
      error: 'Income, location, working status, interests, and about are required'
    });
  }
  if (!Array.isArray(interests) || interests.length === 0) {
    return res.status(400).json({ error: 'Interests must be a non-empty array' });
  }

  try {
    const userRecord = await admin.auth().createUser({ email, password });
    await db.collection('users').doc(userRecord.uid).set({
      email,
      name,
      about,
      id: userRecord.uid,
      income,
      location,
      working_status,
      interests,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.status(201).json({
      message: 'User created successfully',
      uid: userRecord.uid,
      email: userRecord.email,
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Sign-In Endpoint
app.post('/signin', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ error: 'ID token is required' });
  }

  console.log('Received idToken from Flutter app:', idToken);

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User data not found in Firestore' });
    }
    res.status(200).json({
      message: 'Sign-in successful',
      uid,
      email: decodedToken.email,
    });
  } catch (error) {
    console.error('Signin error:', error);
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
});

// Middleware for protected routes
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const idToken = authHeader && authHeader.split(' ')[1];

  if (!idToken) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({ error: 'Invalid token', details: error.message });
  }
};

// Upload Video/Photo to Google Drive
app.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  const file = req.file;
  const userId = req.user.uid;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const fileMetadata = {
      name: `${userId}_${Date.now()}_${file.originalname}`,
      parents: ['1Ppd-_uHyV-0yqFQN5arknplAd-AN65Tt'], // Your folder ID
    };
    const media = {
      mimeType: file.mimetype,
      body: fs.createReadStream(file.path),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, webViewLink, webContentLink',
    });

    const fileId = driveResponse.data.id;
    const fileUrl = `https://drive.google.com/uc?export=download&id=${fileId}`; // Use direct download URL

    await db.collection('uploads').add({
      userId,
      fileId,
      fileUrl,
      fileName: file.originalname,
      mimeType: file.mimetype,
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    fs.unlinkSync(file.path);

    res.status(200).json({
      message: 'File uploaded successfully',
      fileId,
      fileUrl,
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Failed to upload file', details: error.message });
  }
});

// Fetch User's Uploads
app.get('/uploads', authenticateToken, async (req, res) => {
  const userId = req.user.uid;

  try {
    const snapshot = await db.collection('uploads')
      .where('userId', '==', userId)
      .orderBy('uploadedAt', 'desc')
      .get();

    const uploads = snapshot.docs.map(doc => doc.data());
    res.status(200).json({ uploads });
  } catch (error) {
    console.error('Error fetching uploads:', error);
    res.status(500).json({ error: 'Failed to fetch uploads', details: error.message });
  }
});

// Fetch Videos from Google Drive Folder (Updated for Flutter Compatibility)
app.get('/videos', async (req, res) => {
  const folderId = '1Ppd-_uHyV-0yqFQN5arknplAd-AN65Tt'; // Same folder as uploads

  try {
    console.log('Fetching videos from Google Drive folder:', folderId);
    const response = await drive.files.list({
      q: `'${folderId}' in parents mimeType='video/mp4'`, // Filter for MP4 videos
      fields: 'files(id, name, webContentLink)',
    });

    const files = response.data.files || [];
    if (files.length === 0) {
      console.log('No videos found in the folder.');
      return res.status(404).json({ error: 'No videos found in the folder' });
    }

    const videoData = files.map(file => ({
      id: file.id,
      name: file.name,
      url: `https://drive.google.com/uc?export=download&id=${file.id}`, // Consistent with Flutter expectation
    }));

    console.log(`Found ${files.length} videos:`, videoData);
    res.status(200).json({ videos: videoData });
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos', details: error.message });
  }
});

// Protected route example
app.get('/protected', authenticateToken, (req, res) => {
  res.json({ message: 'This is a protected route', uid: req.user.uid });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ message: 'Server is running' });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});