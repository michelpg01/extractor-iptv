const puppeteer = require('puppeteer-core');
const express = require('express');
const axios = require('axios');
const { URL } = require('url');

const app = express();

// ✅ Railway usa un puerto dinámico. Escuchamos en el que nos asigne (o 8080).
const PORT = process.env.PORT || 8080; 

// ✅ Dominio dinámico de Railway. Si falla, usa tu URL actual como respaldo.
const IP_LOCAL = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
    : "https://reliable-consideration-production-9a477ae3.up.railway.app"; 

// 🔑 CONFIGURACIÓN DE BROWSERLESS (Toma el token de las variables de Railway)
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN; 
const BROWSERLESS_ENDPOINT = `wss://production-sfo.browserless.io?token=${BROWSERLESS_TOKEN}`;

const urlCache = {}; // Caché en memoria para los videos

// ==========================================
// 1. EXTRAER Y REGISTRAR (Usando Browserless)
// ==========================================
app.get('/extract', async (req, res) => {
    const embedUrl = req.query.url;
    const videoName = req.query.name || 'video';

    if (!embedUrl) return res.status(400).json({ error: 'Falta url' });

    console.log(`🔍 Extrayendo: ${embedUrl}`);
    const inicio = Date.now();
    let m3u8Url = null;

    try {
        // Conexión al navegador remoto de Browserless
        const browser = await puppeteer.connect({
            browserWSEndpoint: BROWSERLESS_ENDPOINT,
        });
        
        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const type = request.resourceType();
            const url = request.url();

            // Capturar el .m3u8 real
            if (url.includes('.m3u8') && url.includes('morencius.com')) {
                if (!m3u8Url) {
                    m3u8Url = url;
                }
                request.abort();
                return;
            }

            // Bloquear imágenes y css para ir más rápido
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                request.abort();
            } else {
                request.continue();
            }
        });

        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

        const startTime = Date.now();
        while (!m3u8Url && Date.now() - startTime < 10000) {
            await new Promise(r => setTimeout(r, 100));
        }

        await browser.close(); // Cerrar sesión en Browserless

        if (m3u8Url) {
            urlCache[videoName] = {
                real_url: m3u8Url,
                referer: "https://morencius.com/"
            };

            const playableUrl = `${IP_LOCAL}/video/${videoName}.m3u8`;
            console.log(`✅ Listo en ${Date.now() - inicio}ms → ${playableUrl}`);
            res.json({ 
                success: true, 
                playable_url: playableUrl,
                real_url: m3u8Url,
                referer: "https://morencius.com/"
            });
        } else {
            res.status(404).json({ success: false, error: 'No se encontró m3u8' });
        }

    } catch (e) {
        console.error('❌ Error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==========================================
// 2. PROXY M3U8
// ==========================================
app.get('/video/:name.m3u8', async (req, res) => {
    const name = req.params.name;
    const video = urlCache[name];

    if (!video) return res.status(404).send("Video no registrado");

    try {
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": video.referer,
            "Origin": video.referer.slice(0, -1),
            "Accept": "*/*"
        };

        const response = await axios.get(video.real_url, { headers, responseType: 'text' });
        let lines = response.data.split('\n');
        let newLines = [];

        let token = "";
        const urlObj = new URL(video.real_url);
        if (urlObj.searchParams.has('hdnts')) {
            token = `&hdnts=${encodeURIComponent(urlObj.searchParams.get('hdnts'))}`;
        }

        for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            
            if (line.startsWith('#')) {
                newLines.push(line);
            } else {
                if (line.includes('hdnts=')) token = "";
                let absoluteUrl = line.startsWith('http') ? line : new URL(line, video.real_url).toString();
                let encoded = encodeURIComponent(absoluteUrl);
                newLines.push(`${IP_LOCAL}/stream?url=${encoded}&ref=${encodeURIComponent(video.referer)}${token}`);
            }
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(newLines.join('\n'));
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ==========================================
// 3. PROXY DE SEGMENTOS
// ==========================================
app.get('/stream', async (req, res) => {
    const originalUrl = req.query.url;
    const referer = req.query.ref;
    const hdntsToken = req.query.hdnts;

    if (!originalUrl || !referer) return res.status(400).send("Faltan parámetros");

    let finalUrl = originalUrl;
    if (hdntsToken && !finalUrl.includes('hdnts=')) {
        finalUrl += (finalUrl.includes('?') ? '&' : '?') + `hdnts=${hdntsToken}`;
    }

    try {
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": referer,
            "Origin": referer.slice(0, -1),
            "Accept": "*/*"
        };

        const response = await axios.get(finalUrl, { headers, responseType: 'stream' });

        if (finalUrl.includes('.m3u8')) {
            let text = "";
            response.data.on('data', chunk => text += chunk);
            response.data.on('end', () => {
                let lines = text.split('\n');
                let newLines = [];
                let token = hdntsToken ? `&hdnts=${encodeURIComponent(hdntsToken)}` : "";
                
                for (let line of lines) {
                    line = line.trim();
                    if (!line) continue;
                    if (line.startsWith('#')) {
                        newLines.push(line);
                    } else {
                        if (line.includes('hdnts=')) token = "";
                        let absoluteUrl = line.startsWith('http') ? line : new URL(line, finalUrl).toString();
                        let encoded = encodeURIComponent(absoluteUrl);
                        newLines.push(`${IP_LOCAL}/stream?url=${encoded}&ref=${encodeURIComponent(referer)}${token}`);
                    }
                }
                res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.send(newLines.join('\n'));
            });
        } else {
            res.setHeader('Content-Type', finalUrl.includes('.m4s') || finalUrl.includes('.mp4') ? 'video/mp4' : 'video/mp2t');
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.data.pipe(res);
        }
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// ✅ IMPORTANTE: Escuchar en 0.0.0.0 para que Railway asigne el tráfico correctamente
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    console.log(`🔗 URL Base generada: ${IP_LOCAL}`);
});
