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
    logs: []
};

async function initDb() {
    await fs.ensureDir(path.join(__dirname, 'data'));
    if (!await fs.exists(DB_PATH)) {
        await fs.writeJson(DB_PATH, defaultDb, { spaces: 2 });
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
        const index = db.leads.findIndex(l => l.email === lead.email);
        if (index > -1) {
            db.leads[index] = { ...db.leads[index], ...lead };
        } else {
            lead.id = Date.now() + Math.random().toString(36).substr(2, 9);
            lead.importedAt = new Date();
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
        db.logs.push(log);

        const campIndex = db.campaigns.findIndex(c => c.id === log.campaignId);
        if (campIndex > -1) {
            if (log.status === 'sent') db.campaigns[campIndex].sentCount++;
            if (log.status === 'failed') db.campaigns[campIndex].failedCount++;
        }

        await saveDb(db);
    },
    async getLogs(campaignId) {
        const db = await getDb();
        return db.logs.filter(l => l.campaignId === campaignId);
    }
};

module.exports = { storage, initDb };
