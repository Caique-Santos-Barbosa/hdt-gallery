// HDT Conecte Storage v1.1.0 - Robustness Update
const fs = require('fs-extra');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const BACKUP_PATH = path.join(__dirname, 'data', 'db.json.bak');

const defaultDb = {
    config: {
        method: 'smtp',
        senderEmail: '',
        senderName: 'HDT ENERGY',
        smtpHost: '',
        smtpPort: 465,
        smtpSecure: true,
        smtpPassword: '',
        smtpIgnoreCertErrors: false,
        smtpForceSecure: 'auto',
        resendApiKey: 're_ALtAvuYB_3NLwVzeetWhuN6Q9AdtakEkZ',
        resendDomain: '',
        resendFromEmail: '',
        baseUrl: 'https://hdtconecte.hdt.energy/'
    },
    leads: [],
    templates: [],
    campaigns: [],
    logs: [],
    forms: [],
    users: [
        { id: '1', email: 'admin@hdt.com', password: 'admin', role: 'admin', name: 'Administrador' },
        { id: '2', email: 'user@hdt.com', password: 'user', role: 'user', name: 'Usuário' }
    ]
};

// Singleton cache to prevent race conditions during heavy I/O
let dbCache = null;
let isSaving = false;

async function initDb() {
    await fs.ensureDir(path.join(__dirname, 'data'));
    const db = await getDb();
    // Verify default structure
    let updated = false;
    for (const key in defaultDb) {
        if (!db[key]) {
            db[key] = defaultDb[key];
            updated = true;
        }
    }
    if (updated) await saveDb(db);

    // Create initial backup if not exists
    if (!await fs.exists(BACKUP_PATH) && await fs.exists(DB_PATH)) {
        await fs.copy(DB_PATH, BACKUP_PATH);
    }
}

async function getDb() {
    if (dbCache) return dbCache;

    try {
        if (!await fs.exists(DB_PATH)) {
            dbCache = JSON.parse(JSON.stringify(defaultDb));
            return dbCache;
        }

        const raw = await fs.readFile(DB_PATH, 'utf8');
        if (!raw || raw.trim() === '') {
            console.warn('DB file is empty, using defaults');
            dbCache = JSON.parse(JSON.stringify(defaultDb));
            return dbCache;
        }

        dbCache = JSON.parse(raw);
        return dbCache;
    } catch (err) {
        // CRITICAL: If file exists but failed to read/parse, DON'T return empty defaults
        // This prevents overwriting the real DB with an empty one.
        console.error('CRITICAL: DB Read/Parse Error.', err);
        if (await fs.exists(DB_PATH)) {
            throw new Error('Database file exists but is corrupted or locked. Access denied to prevent data loss.');
        }
        dbCache = JSON.parse(JSON.stringify(defaultDb));
        return dbCache;
    }
}

async function saveDb(db) {
    if (!db) return;
    dbCache = db; // Always update cache

    try {
        // Atomic write with temp file
        const tempPath = DB_PATH + '.tmp';
        await fs.writeJson(tempPath, db, { spaces: 2 });

        // Before moving, check if we should create a backup (safety first)
        if (await fs.exists(DB_PATH)) {
            const stats = await fs.stat(DB_PATH);
            // Only backup if current file has content (don't backup a corrupted small file)
            if (stats.size > 100) {
                await fs.copy(DB_PATH, BACKUP_PATH, { overwrite: true });
            }
        }

        await fs.move(tempPath, DB_PATH, { overwrite: true });
    } catch (err) {
        console.error('CRITICAL: DB Save Error:', err);
        throw err; // Propagate for visibility
    }
}

const storage = {
    async getConfig() {
        const db = await getDb();
        return db.config;
    },
    async updateConfig(config) {
        const db = await getDb();
        db.config = { ...db.config, ...config };
        await saveDb(db);
        return db.config;
    },
    async getLeads() {
        const db = await getDb();
        return db.leads || [];
    },
    async saveLead(lead) {
        const db = await getDb();
        const index = lead.id ? db.leads.findIndex(l => l.id === lead.id) : db.leads.findIndex(l => l.email === lead.email);

        if (index > -1) {
            db.leads[index] = { ...db.leads[index], ...lead };
        } else {
            if (!lead.id) lead.id = Date.now() + Math.random().toString(36).substr(2, 9);
            lead.importedAt = lead.importedAt || new Date();
            db.leads.push(lead);
        }
        await saveDb(db);
        return lead;
    },
    async bulkUpsertLeads(leads) {
        const db = await getDb();
        let imported = 0;
        let duplicates = 0;
        leads.forEach(newLead => {
            const index = db.leads.findIndex(l => l.email === newLead.email);
            if (index > -1) {
                db.leads[index] = { ...db.leads[index], ...newLead };
                duplicates++;
            } else {
                newLead.id = Date.now() + Math.random().toString(36).substr(2, 9);
                newLead.importedAt = new Date();
                db.leads.push(newLead);
                imported++;
            }
        });
        await saveDb(db);
        return { imported, duplicates };
    },
    async deleteLead(id) {
        const db = await getDb();
        db.leads = db.leads.filter(l => l.id !== id);
        await saveDb(db);
    },
    async getTemplates() {
        const db = await getDb();
        return db.templates || [];
    },
    async saveTemplate(template) {
        const db = await getDb();
        const index = template.id ? db.templates.findIndex(t => t.id === template.id) : -1;

        if (index > -1) {
            db.templates[index] = { ...db.templates[index], ...template };
        } else {
            if (!template.id) template.id = Date.now() + Math.random().toString(36).substr(2, 9);
            template.createdAt = template.createdAt || new Date();
            db.templates.push(template);
        }
        await saveDb(db);
        return template;
    },
    async deleteTemplate(id) {
        const db = await getDb();
        db.templates = db.templates.filter(t => t.id !== id);
        await saveDb(db);
    },
    async getCampaigns() {
        const db = await getDb();
        return db.campaigns || [];
    },
    async saveCampaign(campaign) {
        const db = await getDb();
        if (campaign.id) {
            const index = db.campaigns.findIndex(c => c.id === campaign.id);
            db.campaigns[index] = { ...db.campaigns[index], ...campaign };
        } else {
            campaign.id = Date.now() + Math.random().toString(36).substr(2, 9);
            campaign.createdAt = new Date();
            campaign.sentCount = 0;
            campaign.deliveredCount = 0;
            campaign.openCount = 0;
            campaign.clickCount = 0;
            campaign.bounceCount = 0;
            campaign.unsubscribeCount = 0;
            campaign.complaintCount = 0;
            campaign.failedCount = 0;
            db.campaigns.push(campaign);
        }
        await saveDb(db);
        return campaign;
    },
    async deleteCampaign(id) {
        const db = await getDb();
        db.campaigns = db.campaigns.filter(c => c.id !== id);
        db.logs = db.logs.filter(l => l.campaignId !== id);
        await saveDb(db);
    },
    async addLog(log) {
        const db = await getDb();
        const fullLog = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            sentAt: new Date(),
            openedAt: null,
            deliveredAt: null,
            bouncedAt: null,
            complainedAt: null,
            unsubscribedAt: null,
            providerId: log.providerId || null,
            clicks: [],
            ...log
        };
        db.logs.push(fullLog);

        const campIndex = db.campaigns.findIndex(c => c.id === log.campaignId);
        if (campIndex > -1) {
            if (log.status === 'sent') db.campaigns[campIndex].sentCount++;
            if (log.status === 'failed') db.campaigns[campIndex].failedCount++;
        }

        await saveDb(db);
        return fullLog;
    },
    async addLogs(logsArray) {
        if (!logsArray || logsArray.length === 0) return [];
        const db = await getDb();
        const now = new Date();
        const fullLogs = logsArray.map(log => ({
            id: Date.now() + Math.random().toString(36).substr(2, 9) + Math.random().toString(36).substr(2, 5),
            sentAt: now,
            openedAt: null,
            deliveredAt: null,
            bouncedAt: null,
            complainedAt: null,
            unsubscribedAt: null,
            providerId: log.providerId || null,
            clicks: [],
            ...log
        }));
        db.logs.push(...fullLogs);

        // Bulk update campaign metrics
        const campaignUpdates = {};
        fullLogs.forEach(log => {
            if (!campaignUpdates[log.campaignId]) campaignUpdates[log.campaignId] = { sent: 0, failed: 0 };
            if (log.status === 'sent') campaignUpdates[log.campaignId].sent++;
            if (log.status === 'failed') campaignUpdates[log.campaignId].failed++;
        });

        for (const campId in campaignUpdates) {
            const campIndex = db.campaigns.findIndex(c => c.id === campId);
            if (campIndex > -1) {
                db.campaigns[campIndex].sentCount = (db.campaigns[campIndex].sentCount || 0) + campaignUpdates[campId].sent;
                db.campaigns[campIndex].failedCount = (db.campaigns[campIndex].failedCount || 0) + campaignUpdates[campId].failed;
            }
        }

        await saveDb(db);
        return fullLogs;
    },
    async updateLog(logId, data) {
        const db = await getDb();
        const index = db.logs.findIndex(l => l.id === logId);
        if (index > -1) {
            const log = db.logs[index];
            const campaignId = log.campaignId;

            // Track if this is the FIRST open/click to avoid double counting
            const isFirstOpen = data.openedAt && !log.openedAt;
            const isFirstClick = data.lastClickedAt && !log.lastClickedAt;

            db.logs[index] = { ...db.logs[index], ...data };

            const campIndex = db.campaigns.findIndex(c => c.id === campaignId);
            if (campIndex > -1) {
                if (isFirstOpen) {
                    db.campaigns[campIndex].openCount = (db.campaigns[campIndex].openCount || 0) + 1;
                }
                if (isFirstClick) {
                    db.campaigns[campIndex].clickCount = (db.campaigns[campIndex].clickCount || 0) + 1;
                }
            }
            await saveDb(db);
        }
    },
    async getLogs(campaignId) {
        const db = await getDb();
        return db.logs.filter(l => l.campaignId === campaignId);
    },
    async getUserByEmail(email) {
        const db = await getDb();
        return db.users.find(u => u.email === email);
    },
    async getForms() {
        const db = await getDb();
        return db.forms || [];
    },
    async saveForm(form) {
        const db = await getDb();
        if (form.id) {
            const index = db.forms.findIndex(f => f.id === form.id);
            if (index > -1) {
                db.forms[index] = { ...db.forms[index], ...form };
            } else {
                db.forms.push(form);
            }
        } else {
            form.id = Date.now() + Math.random().toString(36).substr(2, 9);
            form.createdAt = new Date();
            form.submissions = 0;
            db.forms.push(form);
        }
        await saveDb(db);
        return form;
    },
    async deleteForm(id) {
        const db = await getDb();
        db.forms = db.forms.filter(f => f.id !== id);
        await saveDb(db);
    },
    async incrementFormMetric(id, metric) {
        const db = await getDb();
        const index = db.forms.findIndex(f => f.id === id);
        if (index > -1) {
            if (!db.forms[index][metric]) db.forms[index][metric] = 0;
            db.forms[index][metric]++;
            await saveDb(db);
        }
    },
    async updateUser(id, data) {
        const db = await getDb();
        const index = db.users.findIndex(u => u.id === id);
        if (index > -1) {
            db.users[index] = { ...db.users[index], ...data };
            await saveDb(db);
            return db.users[index];
        }
        return null;
    },
    async getPerformanceStats() {
        const db = await getDb();
        const logs = db.logs || [];
        const last7Days = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const dayLogs = logs.filter(l => {
                const logDate = l.sentAt ? new Date(l.sentAt).toISOString().split('T')[0] : null;
                return logDate === dateStr;
            });
            last7Days.push({
                date: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
                success: dayLogs.filter(l => l.status === 'sent').length,
                failed: dayLogs.filter(l => l.status === 'failed').length
            });
        }
        return last7Days.reverse();
    },
    async getAllTags() {
        const db = await getDb();
        const tags = new Set();
        (db.leads || []).forEach(l => {
            if (l.tags && Array.isArray(l.tags)) {
                l.tags.forEach(t => tags.add(t));
            }
        });
        return Array.from(tags).sort();
    },
    async getLogByProviderId(providerId) {
        const db = await getDb();
        return db.logs.find(l => l.providerId === providerId);
    },
    async processWebhookEvent(providerId, eventType, data = {}) {
        const db = await getDb();
        const logIndex = db.logs.findIndex(l => l.providerId === providerId);
        if (logIndex === -1) return null;

        const log = db.logs[logIndex];
        const campaignId = log.campaignId;
        const campIndex = db.campaigns.findIndex(c => c.id === campaignId);
        if (campIndex === -1) return null;

        const campaign = db.campaigns[campIndex];
        const now = new Date();

        switch (eventType) {
            case 'email.delivered':
                if (!log.deliveredAt) {
                    log.deliveredAt = now;
                    campaign.deliveredCount = (campaign.deliveredCount || 0) + 1;
                }
                break;
            case 'email.opened':
                if (!log.openedAt) {
                    log.openedAt = now;
                    campaign.openCount = (campaign.openCount || 0) + 1;
                }
                break;
            case 'email.clicked':
                // Clicks can happen multiple times, but we only count the first for the campaign metric
                const isFirstClick = !log.lastClickedAt;
                log.lastClickedAt = now;
                if (!log.clicks) log.clicks = [];
                log.clicks.push({ at: now, url: data.url });
                if (isFirstClick) {
                    campaign.clickCount = (campaign.clickCount || 0) + 1;
                }
                break;
            case 'email.bounced':
                if (!log.bouncedAt) {
                    log.bouncedAt = now;
                    log.status = 'bounced';
                    campaign.bounceCount = (campaign.bounceCount || 0) + 1;
                }
                break;
            case 'email.complained':
                if (!log.complainedAt) {
                    log.complainedAt = now;
                    campaign.complaintCount = (campaign.complaintCount || 0) + 1;
                }
                break;
            case 'email.unsubscribed':
                if (!log.unsubscribedAt) {
                    log.unsubscribedAt = now;
                    campaign.unsubscribeCount = (campaign.unsubscribeCount || 0) + 1;
                }
                break;
        }

        await saveDb(db);
        return { log, campaign };
    },
    async unsubscribeLead(logId) {
        const db = await getDb();
        const log = db.logs.find(l => l.id === logId);
        if (!log) return null;

        const leadIndex = db.leads.findIndex(l => l.id === log.leadId || l.email === log.email);
        if (leadIndex > -1) {
            db.leads[leadIndex].status = 'unsubscribed';
        }

        const campIndex = db.campaigns.findIndex(c => c.id === log.campaignId);
        if (campIndex > -1) {
            db.campaigns[campIndex].unsubscribeCount = (db.campaigns[campIndex].unsubscribeCount || 0) + 1;
        }

        await saveDb(db);
        return true;
    },
    async clearCampaignLogs(campaignId) {
        const db = await getDb();
        db.logs = db.logs.filter(l => l.campaignId !== campaignId);
        await saveDb(db);
    },
    getDb,
    saveDb
};

module.exports = { storage, initDb };
