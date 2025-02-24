const { chromium } = require('playwright');
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

// Use a fixed number of threads instead
const NUM_WORKERS = 4; // Always use 4 worker threads
// console.log(`Using ${NUM_WORKERS} worker threads`);
const workers = [];
let currentWorkerIndex = 0;

// Initialize worker pool
function initializeWorkerPool() {
    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(path.join(__dirname, 'worker.js'));
        workers.push(worker);
    }
}

// Get next available worker using round-robin
function getNextWorker() {
    const worker = workers[currentWorkerIndex];
    currentWorkerIndex = (currentWorkerIndex + 1) % workers.length;
    return worker;
}

// Function to extract emails from a webpage
async function extractEmailsFromWebsite(page, url) {
    // console.log(`\nStarting email extraction for URL: ${url}`);
    try {
        if (!url || url === 'N/A') {
            // console.log('Invalid URL provided');
            return 'N/A';
        }

        // Clean URL
        url = url.trim().split('?')[0].replace(/\/+$/, '');
        if (!url.startsWith('http')) {
            url = 'https://' + url;
        }
        // console.log(`Cleaned URL: ${url}`);

        try {
            // console.log('Navigating to website...');
            await page.goto(url, { 
                timeout: 60000,
                waitUntil: 'domcontentloaded'
            });
            // console.log('Successfully loaded website');

            const emails = await extractEmailsFromPage(page);
            // console.log(`Found ${emails.length} potential emails`);  
            
            if (emails.length > 0) {
                // console.log(`Emails found: ${emails.join(', ')}`);
                return emails[0];
            }
            
            // console.log('No emails found on main page, checking contact pages...');
            // Check contact page if no emails found
            const contactLinks = await page.$$eval(
                'a[href*="contact"], a[href*="about"], a[href*="Contact"], a[href*="About"]', 
                links => links.map(link => link.href)
            );
            
            // console.log(`Found ${contactLinks.length} contact/about links`);
            
            for (const contactUrl of contactLinks) {
                try {
                    await page.goto(contactUrl, { timeout: 15000 });
                    const contactEmails = await extractEmailsFromPage(page);
                    if (contactEmails.length > 0) {
                        // console.log(`Found emails on contact page: ${contactUrl}`);
                        return contactEmails[0];
                    }
                } catch (error) {
                    console.log(`Error checking contact page: ${contactUrl}`);
                }
            }
        } catch (error) {
            console.log(`Failed to navigate to ${url}: ${error.message}`);
            return 'N/A';
        }
    } catch (error) {
        console.log(`Email extraction error: ${error.message}`);
        return 'N/A';
    }
}

// Helper function to extract emails from a page
async function extractEmailsFromPage(page) {
    const emails = await page.evaluate(() => {
        const results = [];
        
        // Regular expression for email
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        
        // Get text content
        const text = document.body.innerText;
        const textEmails = text.match(emailRegex) || [];
        results.push(...textEmails);
        
        // Get mailto links
        const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]'))
            .map(link => link.href.replace('mailto:', '').split('?')[0]);
        results.push(...mailtoLinks);
        
        // Get emails from input fields
        const emailInputs = Array.from(document.querySelectorAll('input[type="email"]'))
            .map(input => input.value)
            .filter(email => email.includes('@'));
        results.push(...emailInputs);
        
        return results;
    });
    
    return emails;
}

async function scrapeGoogleMaps(query, total = 100, onDataScraped, signal, extractEmail = false) {
    let browser = null;
    let scrapedData = [];
    let isStopped = false;
    const MAX_CONCURRENT = extractEmail ? 5 : 10; // Reduced concurrent operations for email extraction

    try {
        // Initialize worker pool if not already initialized
        if (workers.length === 0) {
            initializeWorkerPool();
        }

        browser = await chromium.launch({ 
            headless: true,
            args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();

        signal?.addEventListener('abort', () => {
            isStopped = true;
            // console.log('Received abort signal');
        });

        await page.goto('https://www.google.com/maps', { waitUntil: 'networkidle' });
        await page.fill('#searchboxinput', query);
        await page.keyboard.press('Enter');
        await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

        let scrollAttempts = 0;
        let lastResultsCount = 0;
        let consecutiveNoNewResults = 0;

        // Modified processListingsBatch function
        async function processListingsBatch(listings) {
            const results = [];
            const batchSize = Math.min(MAX_CONCURRENT, listings.length);
            
            for (let i = 0; i < listings.length; i += batchSize) {
                if (isStopped) break;
                
                const batch = listings.slice(i, i + batchSize);
                const batchPromises = batch.map(async (listing, index) => {
                    try {
                        const detailsPage = await context.newPage();
                        await detailsPage.setDefaultNavigationTimeout(15000);

                        const href = await listing.getAttribute('href');
                        await detailsPage.goto(href, { waitUntil: 'domcontentloaded' });

                        // Get the phone number element
                        const phoneElement = await detailsPage.$('button[data-item-id^="phone:tel:"] div');
                        let phone = 'N/A';
                        let countryCode = 'N/A';

                        if (phoneElement) {
                            phone = await phoneElement.textContent().catch(() => 'N/A');
                            // Ensure phone is not truncated
                            // console.log(`Extracted phone number: ${phone}`);
                            // Extract country code from phone number
                            const phoneMatch = phone.match(/\+(\d+)/);
                            if (phoneMatch) {
                                countryCode = `+${phoneMatch[1]}`;
                                phone = phone.replace(countryCode, '').trim();
                            } else if (phone.startsWith('0')) {
                                countryCode = '+91'; // Default for India
                                phone = phone.substring(1).trim();
                            } else {
                                countryCode = '+91'; // Default for India
                            }
                        }

                        const business = {
                            name: await listing.getAttribute('aria-label').catch(() => 'N/A'),
                            website: await detailsPage.$eval('a[data-item-id="authority"]', el => el.href).catch(() => 'N/A'),
                            phone,
                            countryCode,
                            address: await detailsPage.$eval('button[data-item-id="address"] div', el => el.textContent.trim()).catch(() => 'N/A'),
                            rating: await detailsPage.$eval('div.F7nice span[aria-hidden="true"]', el => el.textContent.trim()).catch(() => 'N/A'),
                            reviews: await detailsPage.$eval('div.F7nice span[aria-label*="reviews"]', el => el.getAttribute('aria-label').split(' ')[0]).catch(() => 'N/A'),
                            category: await detailsPage.$eval('button.DkEaL', el => el.textContent.trim()).catch(() => 'N/A'),
                            email: 'N/A'
                        };

                        // Process address parts
                        const addressParts = business.address.split(',');
                        if (addressParts.length >= 2) {
                            business.city = addressParts[addressParts.length - 2].trim();
                            const statePin = addressParts[addressParts.length - 1].trim();
                            const pinMatch = statePin.match(/\d{6}/);
                            business.pincode = pinMatch ? pinMatch[0] : 'N/A';
                            business.state = pinMatch ? statePin.replace(pinMatch[0], '').trim() : statePin;
                        }

                        if (extractEmail && business.website !== 'N/A') {
                            try {
                                // Get a worker and create a unique ID for this request
                                const worker = getNextWorker();
                                const requestId = Date.now() + '-' + Math.random();
                                
                                const result = await new Promise((resolve, reject) => {
                                    const timeoutId = setTimeout(() => {
                                        worker.removeListener('message', messageHandler);
                                        resolve({ error: false, email: 'N/A' });
                                    }, 30000); // 30 second timeout

                                    // Create message handler that checks for matching requestId
                                    const messageHandler = (data) => {
                                        if (data.requestId === requestId) {
                                            clearTimeout(timeoutId);
                                            worker.removeListener('message', messageHandler);
                                            resolve(data);
                                        }
                                    };

                                    // Add message listener
                                    worker.on('message', messageHandler);

                                    // Send message with requestId
                                    worker.postMessage({ 
                                        business,
                                        requestId 
                                    });
                                });

                                business.email = result.error ? 'N/A' : (result.email || 'N/A');
                                // console.log(`Found email for ${business.name}: ${business.email}`);
                            } catch (error) {
                                console.error(`Error extracting email for ${business.name}:`, error);
                                business.email = 'N/A';
                            }
                        }

                        await detailsPage.close();
                        return business;

                    } catch (error) {
                        console.error(`Error processing business:`, error.message);
                        return null;
                    }
                });

                const batchResults = await Promise.all(batchPromises);
                results.push(...batchResults.filter(r => r !== null));
            }
            return results;
        }

        while (!isStopped && scrapedData.length < total && scrollAttempts < 100) {
            try {
                await page.evaluate(() => {
                    const feed = document.querySelector('div[role="feed"]'); 
                    if (feed) {
                        feed.scrollTop = feed.scrollHeight;
                    }
                });
                await page.mouse.wheel(0, 1000);
                await page.waitForTimeout(2000);

                const listings = await page.$$('a[href*="https://www.google.com/maps/place"]');
                // console.log(`Found ${listings.length} total listings (${lastResultsCount} previous)`);

                if (listings.length > lastResultsCount) {
                    const newListings = listings.slice(lastResultsCount);
                    const results = await processListingsBatch(newListings);
                    
                    for (const result of results) {
                        scrapedData.push(result);
                        onDataScraped(result);
                        // console.log(`✅ Scraped (${scrapedData.length}/${total}): ${result.name}`);
                    }

                    lastResultsCount = listings.length; 
                    consecutiveNoNewResults = 0;
                } else {
                    consecutiveNoNewResults++;
                    if (consecutiveNoNewResults >= 5) {
                        await page.click('button[aria-label="Show more"]').catch(() => {});
                        if (consecutiveNoNewResults >= 8) break;
                    }
                }

                scrollAttempts++;
            } catch (error) {
                if (error.message.includes('Target closed')) break;
                console.error('Error during scroll:', error.message);
                scrollAttempts++;
            }
        }

        return scrapedData;

    } catch (error) {
        console.error('Scraping error:', error);
        return scrapedData;
    } finally {
        // Cleanup
        for (const worker of workers) {
            worker.terminate();
        }
        if (browser) {
            await browser.close(); 
        }
    }
}

// Cleanup function to terminate workers
function cleanupWorkers() {
    workers.forEach(worker => worker.terminate());
    workers.length = 0;
}

// Handle process termination
process.on('SIGTERM', cleanupWorkers);
process.on('exit', cleanupWorkers);

module.exports = { scrapeGoogleMaps };



