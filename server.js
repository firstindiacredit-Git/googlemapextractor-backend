const express = require('express');
const cors = require('cors');
const { scrapeGoogleMaps } = require('./scraper'); 
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

let currentScraping = null; // Track current scraping process 

const app = express();
app.use(cors());
app.use(express.json()); 
app.get("/hello", (req, res) => { res.send("Hello World"); });

// Add stop endpoint
app.post('/stop-scrape', (req, res) => {
    if (currentScraping) {
        currentScraping.abort();
        currentScraping = null;
        res.json({ message: 'Scraping stopped' });
    } else {
        res.json({ message: 'No active scraping to stop' });   
    }
});

// Endpoint for scraping data
app.post('/scrape', async (req, res) => {
    const { query, total, extractEmail } = req.body;
    
    currentScraping = new AbortController();

    try {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Transfer-Encoding', 'chunked');
        
        let dataCount = 0;
        
        const results = await scrapeGoogleMaps(
            query, 
            total, 
            (data) => {
                // Ensure all fields are strings or null
                const formattedData = {
                    name: String(data.name || 'N/A'),
                    email: String(data.email || 'N/A'),
                    phone: String(data.phone || 'N/A'),
                    website: String(data.website || 'N/A'),
                    category: String(data.category || 'N/A'),
                    rating: String(data.rating || 'N/A'),
                    reviews: String(data.reviews || '0'),
                    countryCode: String(data.countryCode || '+91'),
                    pincode: String(data.pincode || 'N/A'),
                    city: String(data.city || 'N/A'),
                    state: String(data.state || 'N/A'),
                    address: String(data.address || 'N/A')
                };

                if (!res.writableEnded) {
                    res.write(JSON.stringify({ 
                        type: 'update', 
                        data: formattedData,
                        progress: ++dataCount
                    }) + '\n');
                }
            }, 
            currentScraping.signal,
            extractEmail
        );
        
        if (!res.writableEnded) {
            res.write(JSON.stringify({ 
                type: 'complete', 
                totalResults: results.length 
            }));
            res.end();
        }
        
    } catch (error) {
        currentScraping = null;
        if (!res.headersSent) {
            console.error('Scraping failed:', error);
            res.status(500).json({ 
                error: 'Scraping failed', 
                details: error.message 
            });
        }
    }
});

// New endpoint for downloading Excel
app.post('/download', async (req, res) => {
    const { data } = req.body;
    try {
        // Format data to ensure all fields are included
        const formattedData = data.map(item => ({
            Title: item.name,
            Category: item.category,
            Rating: item.rating,
            Reviews: item.reviews,
            'Country Code': item.countryCode || '+91',
            Phone: item.phone,
            Address: item.address,
            Website: item.website,
            Pincode: item.pincode || 'N/A',
            City: item.city || 'N/A',
            State: item.state || 'N/A',
            Email: item.email || 'N/A'
        }));

        // Generate Excel file from formatted data
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.json_to_sheet(formattedData);
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Results');

        // Save Excel file temporarily
        const filePath = path.join(__dirname, 'output.xlsx');
        xlsx.writeFile(workbook, filePath);

        // Send file as response
        res.download(filePath, 'google_maps_data.xlsx', (err) => {
            if (err) {
                console.error('Error sending file:', err);
                res.status(500).json({ error: 'Could not send file' });
            }
            // Clean up
            fs.unlinkSync(filePath);
        });
    } catch (error) {
        console.error('Download failed:', error);
        res.status(500).json({ 
            error: 'Download failed', 
            details: error.message 
        });
    }
});

app.use(express.static(path.join(__dirname, 'dist'))); 
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'dist', 'index.html')); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));