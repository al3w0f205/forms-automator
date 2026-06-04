import axios from 'axios';
import fs from 'fs';
import { resolveMicrosoftUrl } from './microsoftForms.js';

async function run() {
  const url = 'https://forms.office.com/r/zrN0RhXP11';
  const resolvedUrl = await resolveMicrosoftUrl(url);
  console.log('Resolved URL:', resolvedUrl);

  const response = await axios.get(resolvedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    }
  });

  const html = response.data;
  console.log('HTML Length:', html.length);
  
  fs.writeFileSync('./form.html', html);

  // Test the patterns in extractFormDataFromHtml
  const patterns = [
    /var\s+(?:defined|formData|__formData)\s*=\s*(\{[\s\S]*?\});/,
    /window\.__(?:INITIAL_STATE|FORM_DATA|NEXT_DATA)__\s*=\s*(\{[\s\S]*?\});/,
    /data-form-data=['"]([\s\S]*?)['"]/,
    /"questions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/,
    /"formInfo"\s*:\s*(\{[\s\S]*?"questions"[\s\S]*?\})\s*[,}]/,
  ];

  patterns.forEach((pattern, i) => {
    const match = html.match(pattern);
    console.log(`Pattern ${i}:`, !!match);
    if (match) {
      console.log(`Pattern ${i} match (first 200 chars):`, match[1].substring(0, 200));
    }
  });
}

run().catch(console.error);
