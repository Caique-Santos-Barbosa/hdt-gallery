// HDT Conecte Server v1.1.2 - Update: 2026-02-12 02:56
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
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

function chunkArray(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}

// Ensure uploads directory exists
fs.ensureDirSync(path.join(__dirname, 'uploads'));

// Auth Routes
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await storage.getUserByEmail(email);
  if (user && user.password === password) {
    const { password, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.status(401).json({ success: false, error: 'Credenciais inválidas' });
  }
});

// Settings Protection (RBAC)
app.get('/api/marketing/config', async (req, res) => {
  // In a real app, we'd check the token/session here. 
  // For this basic setup, we'll let the frontend handle the initial hide,
  // but we can add a simple header check if needed.
  res.json(await storage.getConfig());
});
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
app.post('/api/marketing/config', async (req, res) => res.json(await storage.updateConfig(req.body)));

app.post('/api/marketing/config/test', async (req, res) => {
  const config = req.body;
  if (config.method === 'resend') {
    const fromEmail = config.resendFromEmail || `no-reply@${config.resendDomain}`;
    const postData = JSON.stringify({
      from: `${config.senderName} <${fromEmail}>`,
      to: config.senderEmail,
      subject: 'Teste de Conexão Resend',
      html: '<p>Sua configuração do Resend está funcionando corretamente!</p>'
    });

    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.resendApiKey}`
      }
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => data += chunk);
      apiRes.on('end', () => {
        if (apiRes.statusCode === 200 || apiRes.statusCode === 201) {
          res.json({ success: true });
        } else {
          res.json({ success: false, error: `Resend API Error: ${apiRes.statusCode} - ${data}` });
        }
      });
    });

    apiReq.on('error', (e) => res.json({ success: false, error: e.message }));
    apiReq.write(postData);
    apiReq.end();
    return;
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpForceSecure === 'true' ? true : (config.smtpForceSecure === 'false' ? false : (config.smtpPort === 465)),
    auth: {
      user: config.senderEmail,
      pass: config.smtpPassword
    },
    tls: {
      rejectUnauthorized: config.smtpIgnoreCertErrors || false
    }
  });

  try {
    await transporter.verify();

    // Also send a test email to confirm actual delivery
    await transporter.sendMail({
      from: `"${config.senderName}" <${config.senderEmail}>`,
      to: config.senderEmail,
      subject: 'Teste de Conexão - HDT Conecte',
      text: 'Este é um e-mail de teste para confirmar que suas configurações de SMTP estão corretas!',
      html: '<div style="font-family: Arial; padding: 20px; border: 1px solid #ddd; border-radius: 10px;"><h2>HDT Conecte</h2><p>Este é um e-mail de teste para confirmar que suas configurações de SMTP estão corretas!</p></div>'
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Leads
app.get('/api/marketing/leads', async (req, res) => res.json(await storage.getLeads()));
app.post('/api/marketing/leads', async (req, res) => res.json(await storage.saveLead(req.body)));
app.delete('/api/marketing/leads/:id', async (req, res) => {
  await storage.deleteLead(req.params.id);
  res.json({ success: true });
});
app.get('/api/marketing/tags', async (req, res) => res.json(await storage.getAllTags()));
app.get('/api/marketing/stats/performance', async (req, res) => res.json(await storage.getPerformanceStats()));
app.put('/api/marketing/leads/:id', async (req, res) => {
  const lead = { ...req.body, id: req.params.id };
  res.json(await storage.saveLead(lead));
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
      email: row.email || row.Email || row.EMAIL || row['Email'] || row['Endereço de e-mail'],
      name: row.name || row.Nome || row.Name || row.NOME || row.NOME_COMPLETO || row.PRIMEIRO_NOME || row.nome_completo,
      telefone: row.telefone || row.Telefone || row.TEL || row.Phone || row.PHONE || row.Celular || row.celular || "",
      empresa: row.empresa || row.Empresa || row.Company || row.COMPANY || row.Razão || row.razão || "",
      cidade_uf: row.cidade_uf || row.Cidade_UF || row.Cidade || row.cidade || row.UF || row.uf || row.Cidade_Estado || "",
      cpf_cnpj: row.cpf_cnpj || row.CPF_CNPJ || row.CPF || row.CNPJ || row.cpf || row.cnpj || row.Documento || "",
      tags: (row.tags || row.Tags || row.TAG || row.Tag || "").split(',').map(t => t.trim()).filter(Boolean),
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
app.put('/api/marketing/templates/:id', async (req, res) => {
  const template = { ...req.body, id: req.params.id };
  res.json(await storage.saveTemplate(template));
});

app.post('/api/marketing/templates/upload', memoryUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const htmlContent = req.file.buffer.toString('utf8');
    const name = req.file.originalname.replace('.html', '');
    const template = await storage.saveTemplate({
      name: name,
      subject: name,
      htmlContent: htmlContent
    });
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.delete('/api/marketing/templates/:id', async (req, res) => {
  await storage.deleteTemplate(req.params.id);
  res.json({ success: true });
});

// Campaigns
app.get('/api/marketing/campaigns', async (req, res) => res.json(await storage.getCampaigns()));
app.post('/api/marketing/campaigns', async (req, res) => res.json(await storage.saveCampaign(req.body)));
app.put('/api/marketing/campaigns/:id', async (req, res) => {
  const campaign = { ...req.body, id: req.params.id };
  res.json(await storage.saveCampaign(campaign));
});
app.delete('/api/marketing/campaigns/:id', async (req, res) => {
  await storage.deleteCampaign(req.params.id);
  res.json({ success: true });
});

app.get('/api/marketing/campaigns/:id/logs', async (req, res) => res.json(await storage.getLogs(req.params.id)));

// Forms (Lead Capture)
app.get('/api/marketing/forms', async (req, res) => res.json(await storage.getForms()));
app.post('/api/marketing/forms', async (req, res) => res.json(await storage.saveForm(req.body)));
app.put('/api/marketing/forms/:id', async (req, res) => {
  const form = { ...req.body, id: req.params.id };
  res.json(await storage.saveForm(form));
});
app.delete('/api/marketing/forms/:id', async (req, res) => {
  await storage.deleteForm(req.params.id);
  res.json({ success: true });
});
app.post('/api/marketing/forms/:id/view', async (req, res) => {
  await storage.incrementFormMetric(req.params.id, 'views');
  res.json({ success: true });
});

// User Profile
app.put('/api/users/:id', async (req, res) => {
  try {
    const user = await storage.updateUser(req.params.id, req.body);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TRACKING ROUTES ---
app.get('/api/t/o/:logId', async (req, res) => {
  try {
    await storage.updateLog(req.params.logId, { openedAt: new Date() });
  } catch (err) { }
  // Return 1x1 transparent PNG
  const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length });
  res.end(buf);
});

app.get('/api/t/c/:logId', async (req, res) => {
  const targetUrl = req.query.u;
  const logId = req.params.logId;
  try {
    const logs = await storage.getLogs(req.query.cid); // Note: cid needed to find log easily? No, logId is unique
    // Wait, storage.updateLog(logId, ...) is fine.
    // We need to track the click
    // I'll update addLog to initialize clicks array
    // Here I'll push to it
    // But storage doesn't have a direct getLogById. I'll add one or use a generic update.
    // For now let's just use updateLog to set a 'clickedAt' or append to clicks.
    // Let's keep it simple: just track that IT WAS clicked.
    await storage.updateLog(logId, { lastClickedAt: new Date() });
  } catch (err) { }
  res.redirect(targetUrl || '/');
});

// Public Form Submission
app.post('/api/forms/:id/submit', async (req, res) => {
  try {
    const forms = await storage.getForms();
    const form = forms.find(f => f.id === req.params.id);
    if (!form) return res.status(404).json({ error: 'Form not found' });

    const leadData = req.body;
    // Automatic Tagging
    if (form.autoTag) {
      const existingTags = leadData.tags || [];
      if (!existingTags.includes(form.autoTag)) {
        leadData.tags = [...existingTags, form.autoTag];
      }
    }

    await storage.saveLead(leadData);

    // Update submission count
    form.submissions = (form.submissions || 0) + 1;
    await storage.saveForm(form);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CAMPAIGN WORKER (Autonomous) ---

const runningCampaigns = new Map();

async function processCampaigns() {
  const allCampaigns = await storage.getCampaigns();

  // 1. Check for scheduled campaigns that should start
  const now = new Date();
  for (const c of allCampaigns) {
    if (c.status === 'scheduled' && c.scheduledAt && new Date(c.scheduledAt) <= now) {
      await storage.saveCampaign({ ...c, status: 'running' });
    }
  }

  // 2. Process running campaigns
  for (const c of allCampaigns) {
    if (c.status === 'running' && !runningCampaigns.has(c.id)) {
      runCampaignTask(c.id);
    }
  }
}

async function runCampaignTask(campaignId) {
  if (runningCampaigns.has(campaignId)) return;
  runningCampaigns.set(campaignId, true);

  try {
    const campaigns = await storage.getCampaigns();
    const campaign = campaigns.find(c => c.id === campaignId);
    if (!campaign || campaign.status !== 'running') return;

    const config = await storage.getConfig();
    const templates = await storage.getTemplates();
    const template = templates.find(t => t.id === campaign.templateId);
    if (!template) {
      await storage.saveCampaign({ ...campaign, status: 'error', errorMsg: 'Template not found' });
      return;
    }

    const allLeads = await storage.getLeads();
    const targetLeads = allLeads.filter(l => {
      if (l.status === 'unsubscribed') return false;
      if (!campaign.targetTags || campaign.targetTags.length === 0) return true;
      return campaign.targetTags.some(t => (l.tags || []).includes(t));
    });

    console.log(`[Worker] Campaign ${campaignId}: Found ${targetLeads.length} target leads`);

    // Update total leads if not set
    if (campaign.totalLeads !== targetLeads.length) {
      await storage.saveCampaign({ ...campaign, totalLeads: targetLeads.length });
    }

    if (targetLeads.length === 0) {
      console.log(`[Worker] Campaign ${campaignId}: No leads to send. Completing.`);
      await storage.saveCampaign({ id: campaignId, status: 'completed' });
      return;
    }

    // Find where we left off (basic resilience) - Only skip successfully SENT emails
    const logs = await storage.getLogs(campaignId);
    const sentEmails = new Set(logs.filter(l => l.status === 'sent').map(l => l.email));
    console.log(`[Worker] Campaign ${campaignId}: ${sentEmails.size} already sent, ${targetLeads.length - sentEmails.size} remaining`);

    const leadsToSend = targetLeads.filter(l => !sentEmails.has(l.email));
    console.log(`[Worker] Campaign ${campaignId}: ${leadsToSend.length} leads truly remaining to send`);

    if (config.method === 'resend' && leadsToSend.length > 0) {
      console.log(`[Worker] Campaign ${campaignId}: Using Resend Batch API for ${leadsToSend.length} leads`);
      const batches = chunkArray(leadsToSend, 100);

      for (const batch of batches) {
        if (!runningCampaigns.has(campaignId)) break;

        const emailBatch = batch.map(lead => {
          const logId = Date.now() + Math.random().toString(36).substr(2, 9);
          const baseUrl = config.baseUrl || 'http://localhost:3000';
          let html = template.htmlContent.replace(/\{\{name\}\}/gi, lead.name || '');
          html = html.replace(/\{\{email\}\}/gi, lead.email);
          html = html.replace(/\{\{company\}\}/gi, lead.empresa || '');
          html = html.replace(/\{\{button_link\}\}/gi, campaign.buttonLink || '#');
          html = html.replace(/\{\{unsubscribe_link\}\}/gi, `${baseUrl}/api/t/u/${logId}`);

          html += `<img src="${baseUrl}/api/t/o/${logId}" width="1" height="1" style="display:none">`;
          html = html.replace(/href="([^"]+)"/gi, (match, url) => {
            if (url.startsWith('http') && !url.includes('/api/t/c/')) {
              return `href="${baseUrl}/api/t/c/${logId}?u=${encodeURIComponent(url)}&cid=${campaignId}"`;
            }
            return match;
          });
          const fromEmail = config.resendFromEmail || `no-reply@${config.resendDomain}`;
          return {
            from: `${campaign.senderName || config.senderName} <${fromEmail}>`,
            to: lead.email,
            subject: campaign.subject,
            html: html,
            metadata: { logId, leadId: lead.id } // For local tracking after send
          };
        });

        try {
          const postData = JSON.stringify(emailBatch.map(e => ({
            from: e.from,
            to: e.to,
            subject: e.subject,
            html: e.html
          })));

          await new Promise((resolve, reject) => {
            const options = {
              hostname: 'api.resend.com',
              port: 443,
              path: '/emails/batch',
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.resendApiKey}`
              }
            };
            const apiReq = https.request(options, (apiRes) => {
              let resBody = '';
              apiRes.on('data', d => resBody += d);
              apiRes.on('end', async () => {
                if (apiRes.statusCode === 200 || apiRes.statusCode === 201) {
                  try {
                    const responseData = JSON.parse(resBody);
                    if (responseData.data && Array.isArray(responseData.data)) {
                      // Update logs with providerId (order is preserved in Resend Batch)
                      for (let i = 0; i < responseData.data.length; i++) {
                        const resendItem = responseData.data[i];
                        const localItem = emailBatch[i];
                        if (resendItem.id && localItem.metadata.logId) {
                          await storage.addLog({
                            id: localItem.metadata.logId,
                            campaignId,
                            leadId: localItem.metadata.leadId,
                            email: localItem.to,
                            status: 'sent',
                            providerId: resendItem.id
                          });
                        }
                      }
                      resolve();
                    } else {
                      // Fallback if data is missing
                      for (const e of emailBatch) {
                        await storage.addLog({ id: e.metadata.logId, campaignId, leadId: e.metadata.leadId, email: e.to, status: 'sent' });
                      }
                      resolve();
                    }
                  } catch (e) {
                    console.error('[Worker] Error parsing Resend response:', e);
                    resolve(); // Proceed anyway
                  }
                }
                else reject(new Error(`Resend Batch Error ${apiRes.statusCode}: ${resBody}`));
              });
            });
            apiReq.on('error', reject);
            apiReq.write(postData);
            apiReq.end();
          });

          // Logs are now handled inside the resolve block above with providerId
          console.log(`[Worker] Campaign ${campaignId}: Sent batch of ${emailBatch.length} emails`);
        } catch (err) {
          console.error(`[Worker] Campaign ${campaignId}: Batch failed:`, err.message);
          for (const e of emailBatch) {
            await storage.addLog({ id: e.metadata.logId, campaignId, leadId: e.metadata.leadId, email: e.to, status: 'failed', errorMsg: err.message });
          }
        }

        // Wait interval between batches
        await new Promise(r => setTimeout(r, (campaign.interval || 1) * 1000));
      }
    } else {
      // SMTP logic (Sequential)
      let transporter = null;
      console.log(`[Worker] Campaign ${campaignId}: Starting mail transporter (SMTP)`);
      const smtpSecure = config.smtpForceSecure === 'true' ? true : (config.smtpForceSecure === 'false' ? false : (config.smtpPort === 465));
      transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: smtpSecure,
        auth: {
          user: config.senderEmail,
          pass: config.smtpPassword
        },
        tls: { rejectUnauthorized: config.smtpIgnoreCertErrors || false },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
      });

      for (const lead of leadsToSend) {
        if (!runningCampaigns.has(campaignId)) break;

        const logId = Date.now() + Math.random().toString(36).substr(2, 9);
        const baseUrl = config.baseUrl || 'http://localhost:3000';
        let html = template.htmlContent.replace(/\{\{name\}\}/gi, lead.name || '');
        html = html.replace(/\{\{email\}\}/gi, lead.email);
        html = html.replace(/\{\{company\}\}/gi, lead.empresa || '');
        html = html.replace(/\{\{button_link\}\}/gi, campaign.buttonLink || '#');
        html = html.replace(/\{\{unsubscribe_link\}\}/gi, `${baseUrl}/api/t/u/${logId}`);
        html += `<img src="${baseUrl}/api/t/o/${logId}" width="1" height="1" style="display:none">`;
        html = html.replace(/href="([^"]+)"/gi, (match, url) => {
          if (url.startsWith('http') && !url.includes('/api/t/c/')) {
            return `href="${baseUrl}/api/t/c/${logId}?u=${encodeURIComponent(url)}&cid=${campaignId}"`;
          }
          return match;
        });

        try {
          await transporter.sendMail({
            from: `"${campaign.senderName || config.senderName}" <${config.senderEmail}>`,
            to: lead.email,
            subject: campaign.subject,
            html: html
          });
          await storage.addLog({ id: logId, campaignId, leadId: lead.id, email: lead.email, status: 'sent' });
        } catch (err) {
          await storage.addLog({ id: logId, campaignId, leadId: lead.id, email: lead.email, status: 'failed', errorMsg: err.message });
        }
        await new Promise(r => setTimeout(r, (campaign.interval || 60) * 1000));
      }
    }

    // Refresh and check if all are sent
    const updatedLogs = await storage.getLogs(campaignId);
    if (updatedLogs.filter(l => l.status === 'sent').length >= targetLeads.length) {
      await storage.saveCampaign({ id: campaignId, status: 'completed' });
    }
  } catch (err) {
    console.error(`Error in campaign ${campaignId}:`, err);
  } finally {
    runningCampaigns.delete(campaignId);
  }
}

// Start worker loop
setInterval(processCampaigns, 10000); // Check every 10s

app.post('/api/marketing/campaigns/:id/start', async (req, res) => {
  const campaigns = await storage.getCampaigns();
  const c = campaigns.find(item => item.id === req.params.id);
  if (c) {
    await storage.saveCampaign({ ...c, status: 'running' });
  }
  res.json({ success: true });
});

app.post('/api/marketing/campaigns/:id/stop', async (req, res) => {
  const { id } = req.params;
  runningCampaigns.delete(id);
  const campaigns = await storage.getCampaigns();
  const campaign = campaigns.find(c => c.id === id);
  if (campaign) {
    await storage.saveCampaign({ ...campaign, status: 'paused' });
  }
  res.json({ success: true });
});

app.post('/api/marketing/campaigns/:id/restart', async (req, res) => {
  const { id } = req.params;
  try {
    const campaigns = await storage.getCampaigns();
    const campaign = campaigns.find(c => c.id === id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Reset progress
    campaign.sentCount = 0;
    campaign.deliveredCount = 0;
    campaign.openCount = 0;
    campaign.clickCount = 0;
    campaign.bounceCount = 0;
    campaign.unsubscribeCount = 0;
    campaign.complaintCount = 0;
    campaign.failedCount = 0;
    campaign.status = 'paused'; // Set to paused first to ensure worker doesn't pick it up mid-reset
    await storage.saveCampaign(campaign);

    // Clear logs for this campaign
    await storage.clearCampaignLogs(id);

    // Set to running to start over
    await storage.saveCampaign({ ...campaign, status: 'running' });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- WEBHOOKS ---

app.post('/api/webhooks/resend', async (req, res) => {
  const event = req.body;

  // Resend webhook format: { created_at, data: { ... }, type: "email.delivered" }
  // data contains email_id
  const eventType = event.type;
  const emailId = event.data?.email_id || event.data?.id;

  if (!emailId || !eventType) {
    return res.status(400).send('Invalid webhook data');
  }

  console.log(`[Webhook] Resend Event: ${eventType} for ${emailId}`);

  try {
    const result = await storage.processWebhookEvent(emailId, eventType, event.data);
    if (result) {
      res.json({ success: true, campaign: result.campaign.id });
    } else {
      res.status(404).json({ error: 'Log not found for this providerId' });
    }
  } catch (err) {
    console.error('[Webhook] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- TRACKING & UNSUBSCRIBE ---

app.get('/api/t/u/:logId', async (req, res) => {
  const { logId } = req.params;
  const success = await storage.unsubscribeLead(logId);
  if (success) {
    res.send(`
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 50px; background-color: #0c0e1a; color: white; height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;">
        <h1 style="color: #ff4444; font-size: 48px; margin-bottom: 20px;">✓</h1>
        <h2 style="margin-bottom: 10px;">Você foi descadastrado com sucesso</h2>
        <p style="color: #94a3b8;">Lamentamos ver você partir. Você não receberá mais e-mails desta campanha.</p>
        <div style="margin-top: 30px; border: 1px solid #1e293b; padding: 20px; border-radius: 15px; background: #111827;">
          <img src="https://hdt.energy/wp-content/uploads/2023/10/logo-hdt-energy.png" width="150" alt="HDT Energy">
        </div>
      </div>
    `);
  } else {
    res.status(404).send('Link inválido ou expirado.');
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
});

(async () => {
  await initDb();
  const PORT = 80;
  app.listen(PORT, () => console.log(`HDT Conecte running on port ${PORT}`));
})();
