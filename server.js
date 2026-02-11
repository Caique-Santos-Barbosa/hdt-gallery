const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { nanoid } = require('nanoid');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure uploads directory exists
fs.ensureDirSync('uploads');

// Configure Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const id = nanoid(10);
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only images are allowed (jpg, jpeg, png, gif, webp)'));
  }
});

// API: Upload image
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  const imageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

  res.json({
    success: true,
    url: imageUrl,
    filename: req.file.filename,
    originalName: req.file.originalname
  });
});

// API: List images
app.get('/api/images', async (req, res) => {
  try {
    const files = await fs.readdir('uploads');
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

    const images = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return !file.startsWith('.') && allowedExtensions.includes(ext);
      })
      .map(file => {
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('host');
        return {
          filename: file,
          url: `${protocol}://${host}/uploads/${file}`
        };
      });
    res.json(images.reverse()); // Newest first
  } catch (err) {
    res.status(500).json({ error: 'Could not list images' });
  }
});

// API: Delete image
app.delete('/api/images/:filename', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    await fs.remove(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete image' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
