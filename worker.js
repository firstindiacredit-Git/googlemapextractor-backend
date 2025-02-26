const { parentPort } = require('worker_threads');
const { chromium } = require('playwright');

let browser = null;

async function initBrowser() {
    try {
        // Close existing browser if it exists
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }

        // Create new browser instance
        browser = await chromium.launch({
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox']
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            viewport: { width: 1280, height: 720 },
            bypassCSP: true,
            ignoreHTTPSErrors: true
        });

        const page = await context.newPage();
        await page.setDefaultTimeout(15000);
        await page.setDefaultNavigationTimeout(15000);

        return { page, context };
    } catch (error) {
        console.error('Browser initialization error:', error);
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
        return null;
    }
}

async function extractEmailsFromPage(page) {
    try {
        if (!page || page.isClosed()) return null;

        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1500);

        const emails = await page.evaluate(() => {
            const results = new Set();
            const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
            
            // First check mailto links (most reliable)
            document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
                if (link.href) {
                    const email = link.href.replace('mailto:', '').split('?')[0];
                    if (email) results.add(email.toLowerCase());
                }
            });

            // Then check page content
            const content = document.body.innerText;
            const matches = content.match(emailRegex) || [];
            matches.forEach(email => {
                email = email.toLowerCase().trim();
                if (email.length > 5 && 
                    email.length < 100 && 
                    !email.includes('example') &&
                    !email.includes('test@') &&
                    !email.includes('email@')) {
                    results.add(email);
                }
            });

            return Array.from(results);
        });

        return emails.length > 0 ? emails[0] : null;
    } catch (error) {
        console.error('Error extracting email:', error);
        return null;
    }
}

async function safeGoTo(page, url) {
    try {
        if (!page || page.isClosed()) return false;

        url = url.trim();
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        await page.goto(url, {
            timeout: 15000,
            waitUntil: 'domcontentloaded'
        });
        
        await page.waitForTimeout(1500);
        return true;
    } catch (error) {
        console.error(`Navigation error for ${url}:`, error.message);
        return false;
    }
}

parentPort.on('message', async (data) => {
    let page = null;
    let context = null;
    
    try {
        const { business, requestId } = data;
        
        if (!business?.website || business.website === 'N/A') {
            parentPort.postMessage({ requestId, error: false, email: 'N/A' });
            return;
        }

        const result = await initBrowser();
        if (!result) {
            parentPort.postMessage({ requestId, error: true, email: 'N/A' });
            return;
        }

        ({ page, context } = result);
        let email = null;

        // Try main page
        if (await safeGoTo(page, business.website)) {
            email = await extractEmailsFromPage(page);
        }

        // Try contact page if no email found
        if (!email && !page.isClosed()) {
            const contactPaths = ['contact', 'contact-us', 'about'];
            
            for (const path of contactPaths) {
                if (email) break;
                
                const contactUrl = `${business.website.replace(/\/+$/, '')}/${path}`;
                if (await safeGoTo(page, contactUrl)) {
                    email = await extractEmailsFromPage(page);
                }
            }
        }

        parentPort.postMessage({ requestId, error: false, email: email || 'N/A' });

    } catch (error) {
        console.error('Worker error:', error);
        parentPort.postMessage({ requestId: data?.requestId, error: true, email: 'N/A' });
    } finally {
        try {
            if (page && !page.isClosed()) await page.close().catch(() => {});
            if (context) await context.close().catch(() => {});
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
});

// Clean up browser on exit
process.on('exit', async () => {
    if (browser) {
        await browser.close().catch(() => {});
        browser = null;
    }
});

// Handle worker termination
process.on('SIGTERM', async () => {
    try {
        if (browser) await browser.close().catch(() => {});
        browser = null;
    } catch (error) {
        console.error('SIGTERM cleanup error:', error);
    }
});  