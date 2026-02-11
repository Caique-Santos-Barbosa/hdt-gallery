const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const cors = require('cors');
const { nanoid } = require('nanoid');
const nodemailer = require('nodemailer');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { storage, initDb } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
fs.ensureDirSync(path.join(__dirname, 'uploads'));

// Multer Setup
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${nanoid()}${ext}`);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Memory storage for CSV/XLSX imports
const memoryUpload = multer({ storage: multer.memoryStorage() });

// --- GALLERY APIS ---

app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('host');
  const imageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
  res.json({ success: true, url: imageUrl, filename: req.file.filename });
});

app.get('/api/images', async (req, res) => {
  try {
    const files = await fs.readdir('uploads');
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const images = files
      .filter(file => !file.startsWith('.') && allowedExtensions.includes(path.extname(file).toLowerCase()))
      .map(file => {
        const protocol = req.get('x-forwarded-proto') || req.protocol;
        const host = req.get('host');
        return {
          filename: file,
          url: `${protocol}://${host}/uploads/${file}`
        };
      });
    res.json(images.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Could not list images' });
  }
});

app.delete('/api/images/:filename', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    await fs.remove(filePath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete image' });
  }
});

// --- MAIL MARKETING APIS ---

// Config
app.get('/api/marketing/config', async (req, res) => res.json(await storage.getConfig()));
app.post('/api/marketing/config', async (req, res) => res.json(await storage.updateConfig(req.body)));

// Leads
app.get('/api/marketing/leads', async (req, res) => res.json(await storage.getLeads()));
app.post('/api/marketing/leads', async (req, res) => res.json(await storage.saveLead(req.body)));
app.delete('/api/marketing/leads/:id', async (req, res) => {
  await storage.deleteLead(req.params.id);
  res.json({ success: true });
});

// Import Leads
app.post('/api/marketing/leads/import', memoryUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    let rows = [];
    const buffer = req.file.buffer;
    const name = req.file.originalname.toLowerCase();

    if (name.endsWith('.csv')) {
      rows = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, delimiter: [',', ';'] });
    } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    }

    const leads = rows.map(row => ({
      email: row.email || row.Email || row.EMAIL,
      name: row.name || row.Nome || row.Name || row.NOME,
      tags: (row.tags || row.Tags || "").split(',').map(t => t.trim()).filter(Boolean),
      status: 'active'
    })).filter(l => l.email);

    const result = await storage.bulkUpsertLeads(leads);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Templates
app.get('/api/marketing/templates', async (req, res) => res.json(await storage.getTemplates()));
app.post('/api/marketing/templates', async (req, res) => res.json(await storage.saveTemplate(req.body)));
app.delete('/api/marketing/templates/:id', async (req, res) => {
  await storage.deleteTemplate(req.params.id);
  res.json({ success: true });
});

// Campaigns
app.get('/api/marketing/campaigns', async (req, res) => res.json(await storage.getCampaigns()));
app.post('/api/marketing/campaigns', async (req, res) => res.json(await storage.saveCampaign(req.body)));
app.delete('/api/marketing/campaigns/:id', async (req, res) => {
  await storage.deleteCampaign(req.params.id);
  res.json({ success: true });
});

app.get('/api/marketing/campaigns/:id/logs', async (req, res) => res.json(await storage.getLogs(req.params.id)));

// --- CAMPAIGN WORKER ---

const runningCampaigns = new Map();

async function startCampaign(campaignId) {
  if (runningCampaigns.has(campaignId)) return;

  const db = await storage.getCampaigns();
  const campaign = db.find(c => c.id === campaignId);
  if (!campaign) return;

  const config = await storage.getConfig();
  const templates = await storage.getTemplates();
  const template = templates.find(t => t.id === campaign.templateId);
  if (!template) return;

  const allLeads = await storage.getLeads();
  const leads = allLeads.filter(l => {
    if (!campaign.targetTags || campaign.targetTags.length === 0) return true;
    return campaign.targetTags.some(t => l.tags.includes(t));
  });

  await storage.saveCampaign({ ...campaign, status: 'running', totalLeads: leads.length });

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.senderEmail,
      pass: config.smtpPassword
    }
  });

  runningCampaigns.set(campaignId, true);

  (async () => {
    for (const lead of leads) {
      if (!runningCampaigns.has(campaignId)) break;

      let html = template.htmlContent.replace(/\{\{name\}\}/gi, lead.name || '');
      html = html.replace(/\{\{email\}\}/gi, lead.email);

      try {
        await transporter.sendMail({
          from: `"${campaign.senderName || config.senderName}" <${config.senderEmail}>`,
          to: lead.email,
          subject: campaign.subject,
          html: html
        });
        await storage.addLog({ campaignId, leadId: lead.id, email: lead.email, status: 'sent' });
      } catch (err) {
        await storage.addLog({ campaignId, leadId: lead.id, email: lead.email, status: 'failed', errorMsg: err.message });
      }

      // Small delay between emails
      await new Promise(r => setTimeout(r, 1000));
    }

    await storage.saveCampaign({ id: campaignId, status: 'completed' });
    runningCampaigns.delete(campaignId);
  })();
}

app.post('/api/marketing/campaigns/:id/start', async (req, res) => {
  startCampaign(req.params.id);
  res.json({ success: true });
});

app.post('/api/marketing/campaigns/:id/stop', (req, res) => {
  runningCampaigns.delete(req.params.id);
  res.json({ success: true });
});

// App Start
app.get('/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`HDT Conecte running on port ${PORT}`));
})();
