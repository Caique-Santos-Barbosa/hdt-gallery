const fs = require('fs-extra');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

const defaultDb = {
    config: {
        method: 'smtp',
        senderEmail: '',
        senderName: 'HDT ENERGY',
        smtpHost: '',
        smtpPort: 465,
        smtpSecure: true,
        smtpPassword: ''
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

async function initDb() {
    await fs.ensureDir(path.join(__dirname, 'data'));
    if (!await fs.exists(DB_PATH)) {
        await fs.writeJson(DB_PATH, defaultDb, { spaces: 2 });
    } else {
        // Migration: ensure users array exists
        const db = await getDb();
        if (!db.users) {
            db.users = defaultDb.users;
            await saveDb(db);
        }
        if (!db.forms) {
            db.forms = [];
            await saveDb(db);
        }
    }
}

async function getDb() {
    return await fs.readJson(DB_PATH);
}

async function saveDb(db) {
    await fs.writeJson(DB_PATH, db, { spaces: 2 });
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
        return db.leads;
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
        return db.templates;
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
        return db.campaigns;
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
        log.id = Date.now() + Math.random().toString(36).substr(2, 9);
        log.sentAt = new Date();
        log.openedAt = null;
        log.clicks = [];
        db.logs.push(log);

        const campIndex = db.campaigns.findIndex(c => c.id === log.campaignId);
        if (campIndex > -1) {
            if (log.status === 'sent') db.campaigns[campIndex].sentCount++;
            if (log.status === 'failed') db.campaigns[campIndex].failedCount++;
        }

        await saveDb(db);
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
    }
};

module.exports = { storage, initDb };
