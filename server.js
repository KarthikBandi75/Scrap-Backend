import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));


const leadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: { type: String, required: true },
  phone: { type: String, required: true },
  website: { type: String },
  summary: { type: String },
});

const Lead = mongoose.model('Lead', leadSchema);


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });


const cleanSummary = (text) => {
  if (!text) return 'No summary available.';
  return text
    .replace(/^"|"$/g, '') 
    .replace(/```json|```|\[|\]/g, '') 
    .replace(/\\"/g, '"') 
    .replace(/^\d+\.\s*/, '') 
    .trim();
};

app.post('/api/leads', async (req, res) => {
  const { query, location } = req.body;

  if (!query || !location) {
    return res.status(400).json({ error: 'Query and location are required' });
  }

  try {
    if (!process.env.SERP_API_KEY || !process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server configuration error: Missing API keys' });
    }

  
    const locationResponse = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google_maps',
        q: location,
        type: 'search',
        api_key: process.env.SERP_API_KEY,
      },
    });

    const coordinates = locationResponse.data.place_results?.gps_coordinates || 
                       locationResponse.data.local_results?.[0]?.gps_coordinates || 
                       { latitude: 40.7128, longitude: -74.0060 };
    const ll = `@${coordinates.latitude},${coordinates.longitude},14z`;

    
    const serpResponse = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google_maps',
        q: query,
        ll: ll,
        type: 'search',
        api_key: process.env.SERP_API_KEY,
      },
    });

    const businesses = serpResponse.data.local_results || [];
    if (!businesses.length) {
      return res.status(404).json({ error: 'No businesses found' });
    }

    const leads = businesses.map((business) => ({
      name: business.title || 'Unknown',
      address: business.address || 'Address not available',
      phone: business.phone || 'Phone not available',
      website: business.website,
      description: business.description || 'No description available',
    }));

   
    let summarizedLeads = leads;
    try {
      const descriptions = leads
        .map((lead, index) => `${index + 1}. ${lead.name}: ${lead.description}`)
        .join('\n');
      const prompt = `Summarize each description in 50 words or less. Return a JSON array of strings, ensuring one summary per description provided. If a description is missing or unprocessable, return "No summary available." for that entry:\n${descriptions}`;

      const result = await model.generateContent(prompt);
      let summaries;
      try {
        summaries = JSON.parse(result.response.text());
      } catch (parseError) {
        console.error('Failed to parse Gemini response as JSON:', parseError.message);
        
        summaries = result.response.text()
          .split('\n')
          .filter(s => s.trim())
          .map(s => cleanSummary(s)) || [];
      }

     
      summaries = Array.isArray(summaries) ? summaries.map(cleanSummary) : [];
      while (summaries.length < leads.length) {
        summaries.push('No summary available.');
      }

      summarizedLeads = leads.map((lead, index) => ({
        name: lead.name,
        address: lead.address,
        phone: lead.phone,
        website: lead.website,
        summary: summaries[index] || 'No summary available.',
      }));
    } catch (geminiError) {
      console.error('Gemini API error:', geminiError.message);
      summarizedLeads = leads.map(lead => ({
        name: lead.name,
        address: lead.address,
        phone: lead.phone,
        website: lead.website,
        summary: 'Summary unavailable due to API error',
      }));
    }

   
    try {
      await Lead.insertMany(summarizedLeads, { ordered: false });
    } catch (mongoError) {
      if (mongoError.code !== 11000) {
        throw mongoError;
      }
    }

    res.json(summarizedLeads);
  } catch (error) {
    console.error('Error in /api/leads:', error.message, error.stack);
    res.status(500).json({ error: 'Error fetching or processing leads', details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));