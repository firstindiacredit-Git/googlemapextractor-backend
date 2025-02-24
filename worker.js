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

        return page;
    } catch (error) {
        console.error('Browser initialization error:', error);
        return null;
    }
}

async function extractEmailsFromPage(page) {
    try {
        // Wait for content to load with safety checks
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2000);

        // Check if page is still valid
        if (!page || page.isClosed()) {
            return null;
        }

        const emails = await page.evaluate(() => {
            const results = new Set();
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
            
            function addEmail(email) {
                if (!email) return;
                email = email.toLowerCase().trim();
                if (email.length > 5 && 
                    email.length < 100 && 
                    email.includes('@') && 
                    email.includes('.') && 
                    !email.includes('example') &&
                    !email.includes('test@')) {
                    results.add(email);
                }
            }

            try {
                // Safely get document content
                const doc = document.documentElement;
                if (!doc) return [];

                // Search in HTML content
                const htmlContent = doc.outerHTML || '';
                const htmlEmails = htmlContent.match(emailRegex) || [];
                htmlEmails.forEach(addEmail);

                // Search in text content
                const textContent = document.body?.innerText || '';
                const textEmails = textContent.match(emailRegex) || [];
                textEmails.forEach(addEmail);

                // Search in mailto links
                document.querySelectorAll('a[href^="mailto:"]').forEach(link => {
                    if (link.href) {
                        const email = link.href.replace('mailto:', '').split('?')[0];
                        addEmail(email);
                    }
                });

                return Array.from(results);
            } catch (e) {
                console.error('Error in page evaluation:', e);
                return [];
            }
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
        });
        
        await page.waitForTimeout(2000);
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
            parentPort.postMessage({ 
                requestId,
                error: false, 
                email: null 
            });
            return;
        }

        page = await initBrowser();
        if (!page) {
            parentPort.postMessage({ 
                requestId,
                error: true, 
                email: null 
            });
            return;
        }

        context = page.context();
        let email = null;

        // Try main page
        if (await safeGoTo(page, business.website)) {
            email = await extractEmailsFromPage(page);
        }

        // If no email found and page is still valid, try contact pages
        if (!email && page && !page.isClosed()) {
            const contactPaths = [
                'contact',
                'contact-us',
                'about',
                'about-us',
                'contact.html',
                'contact-us.html'
            ];

            for (const path of contactPaths) {
                if (email || page.isClosed()) break;
                const contactUrl = `${business.website.replace(/\/+$/, '')}/${path}`;
                if (await safeGoTo(page, contactUrl)) {
                    email = await extractEmailsFromPage(page);
                }
            }
        }

        // Send response with requestId
        parentPort.postMessage({ 
            requestId,
            error: false, 
            email 
        });

    } catch (error) {
        console.error('Worker error:', error);
        parentPort.postMessage({ 
            requestId,
            error: true, 
            email: null 
        });
    } finally {
        try {
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
            if (context) {
                await context.close().catch(() => {});
            }
            if (browser) {
                await browser.close().catch(() => {});
                browser = null;
            }
        } catch (error) {
            console.error('Cleanup error:', error);
        }
    }
});

// Cleanup on exit
process.on('exit', async () => {
    if (browser) {
        await browser.close().catch(() => {});
        browser = null;
    }
});  