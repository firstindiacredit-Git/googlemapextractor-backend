const { parentPort } = require('worker_threads');
const { chromium } = require('playwright');

let browser = null;

async function initBrowser() {
    try {
        // Always create a new browser instance for each request
        if (browser) {
            await browser.close().catch(() => {});
        }

        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox'
            ]
        });

        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            viewport: { width: 1280, height: 720 }
        });

        const page = await context.newPage();
        return { page, context };
    } catch (error) {
        console.error('Browser initialization error:', error);
        return null;
    }
}

async function extractEmailsFromPage(page) {
    try {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2000);

        const emails = await page.evaluate(() => {
            const results = new Set();
            const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
            
            // Get all text content
            const textContent = document.body.innerText;
            const matches = textContent.match(emailRegex) || [];
            
            matches.forEach(email => {
                email = email.toLowerCase().trim();
                if (email.length > 5 && 
                    email.length < 100 && 
                    !email.includes('example') &&
                    !email.includes('test@')) {
                    results.add(email);
                }
            });

            // Check mailto links
            document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
                const email = link.href.replace('mailto:', '').split('?')[0];
                if (email) results.add(email.toLowerCase());
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
        url = url.trim();
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }

        await page.goto(url, {
            timeout: 15000,
            waitUntil: 'domcontentloaded'
        });
        
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
            console.log(`Found email on main page: ${email}`);
        }

        // Try contact page if no email found
        if (!email) {
            const contactPaths = ['contact', 'contact-us'];
            
            for (const path of contactPaths) {
                if (email) break;
                
                const contactUrl = `${business.website.replace(/\/+$/, '')}/${path}`;
                if (await safeGoTo(page, contactUrl)) {
                    email = await extractEmailsFromPage(page);
                    if (email) console.log(`Found email on contact page: ${email}`);
                }
            }
        }

        parentPort.postMessage({ requestId, error: false, email: email || 'N/A' });

    } catch (error) {
        console.error('Worker error:', error);
        parentPort.postMessage({ requestId: data?.requestId, error: true, email: 'N/A' });
    } finally {
        try {
            if (page) await page.close().catch(() => {});
            if (context) await context.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
            browser = null;
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
    if (browser) {
        await browser.close().catch(() => {});
        browser = null;
    }
});  