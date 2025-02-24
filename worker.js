const { parentPort } = require('worker_threads');
const { chromium } = require('playwright');

let browser = null;

async function initBrowser() {
    try {
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
        await page.setDefaultTimeout(30000);
        await page.setDefaultNavigationTimeout(30000);

        return { page, context };
    } catch (error) {
        console.error('Browser initialization error:', error);
        return null;
    }
}

async function extractEmailsFromPage(page) {
    try {
        if (!page || page.isClosed()) return null;

        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2000);

        const emails = await page.evaluate(() => {
            const results = new Set();
            const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
            
            function addEmail(email) {
                if (!email) return;
                email = email.toLowerCase().trim();
                if (email.length > 5 && 
                    email.length < 100 && 
                    email.includes('@') && 
                    email.includes('.') && 
                    !email.includes('example') &&
                    !email.includes('test@') &&
                    !email.includes('email@') &&
                    !email.includes('your@') &&
                    !email.includes('sample@') &&
                    !email.includes('demo@') &&
                    !email.includes('domain')) {
                    results.add(email);
                }
            }

            // Search in all content
            const htmlContent = document.documentElement.innerHTML || '';
            const textContent = document.documentElement.textContent || '';

            // Extract from HTML and text
            [htmlContent, textContent].forEach(content => {
                const matches = content.match(emailRegex) || [];
                matches.forEach(addEmail);
            });

            // Extract from mailto links
            document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
                if (link.href) {
                    const email = link.href.replace('mailto:', '').split('?')[0];
                    addEmail(email);
                }
            });

            // Extract from forms
            document.querySelectorAll('input[type="email"]').forEach(input => {
                if (input.value) addEmail(input.value);
            });

            return Array.from(results);
        }).catch(() => []);

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
            timeout: 30000,
            waitUntil: 'domcontentloaded'
        }).catch(() => {});
        
        await page.waitForTimeout(2000).catch(() => {});
        return !page.isClosed();
    } catch (error) {
        console.error(`Navigation error for ${url}:`, error.message);
        return false;
    }
}

parentPort.on('message', async (data) => {
    let browser = null;
    let page = null;
    let context = null;
    
    try {
        const { business, requestId } = data;
        
        if (!business?.website || business.website === 'N/A') {
            parentPort.postMessage({ requestId, error: false, email: null });
            return;
        }

        const result = await initBrowser();
        if (!result) {
            parentPort.postMessage({ requestId, error: true, email: null });
            return;
        }

        ({ page, context } = result);
        browser = context.browser();
        let email = null;

        if (await safeGoTo(page, business.website)) {
            email = await extractEmailsFromPage(page);
        }

        if (!email && page && !page.isClosed()) {
            const contactPaths = [
                'contact', 'contact-us', 'about', 'about-us',
                'contact.html', 'contact-us.html', 'about.html'
            ];

            for (const path of contactPaths) {
                if (email || page.isClosed()) break;
                
                const contactUrl = `${business.website.replace(/\/+$/, '')}/${path}`;
                if (await safeGoTo(page, contactUrl)) {
                    email = await extractEmailsFromPage(page);
                }
                
                if (!page.isClosed()) {
                    await page.waitForTimeout(1000).catch(() => {});
                }
            }
        }

        if (!page.isClosed()) {
            parentPort.postMessage({ requestId, error: false, email });
        }

    } catch (error) {
        console.error('Worker error:', error);
        if (data?.requestId) {
            parentPort.postMessage({ requestId: data.requestId, error: true, email: null });
        }
    } finally {
        try {
            if (page && !page.isClosed()) await page.close().catch(() => {});
            if (context) await context.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
});

process.on('exit', async () => {
    try {
        if (browser) await browser.close().catch(() => {});
    } catch (error) {
        console.error('Exit cleanup error:', error);
    }
});  