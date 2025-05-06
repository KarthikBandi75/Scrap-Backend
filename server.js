import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();


if (!process.env.SERP_API_KEY || !process.env.MONGO_URI) {
  console.error('Missing required environment variables.');
  process.exit(1);
}


app.use(cors({
  origin: 'https://scrap-frontend.vercel.app',
  credentials: true,
}));

app.use(express.json());


mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });


const reviewSchema = new mongoose.Schema({
  author: { type: String, required: true },
  rating: { type: Number, required: true },
  text: { type: String, required: true },
  time: String,
  business: String,
});

const Review = mongoose.model('Review', reviewSchema);


const urlCache = new Map(); 
const placeIdCache = new Map(); 


const isGoogleMapsUrl = (input) => {
  return (
    input.startsWith('https://g.co/kgs/') ||
    input.includes('google.com/maps/') ||
    input.startsWith('https://maps.app.goo.gl/')
  );
};

const isPlaceId = (input) => {
  return /^ChIJ/.test(input);
};

const resolveGoogleMapsUrl = async (url) => {
  if (urlCache.has(url)) {
    return urlCache.get(url);
  }

  try {
    const response = await axios.get(url, {
      maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
    });

    const finalUrl = response.request.res.responseUrl;
    const placeNameMatch = finalUrl.match(/place\/([^/]+)\/?/i) || finalUrl.match(/q=([^&]+)/i);
    
    if (!placeNameMatch) {
      return null;
    }

    const placeName = decodeURIComponent(placeNameMatch[1]).replace(/\+/g, ' ').trim();
    urlCache.set(url, placeName);
    return placeName;
  } catch (error) {
    console.error('Error resolving URL:', error.message);
    return null;
  }
};

const getPlaceId = async (input) => {
  
  if (isPlaceId(input)) {
    return input;
  }

  
  let placeName = input;
  if (isGoogleMapsUrl(input)) {
    const resolvedName = await resolveGoogleMapsUrl(input);
    if (!resolvedName) return null;
    placeName = resolvedName;
  }

 
  const cacheKey = placeName.toLowerCase();
  if (placeIdCache.has(cacheKey)) {
    return placeIdCache.get(cacheKey);
  }

  
  try {
    const params = {
      engine: 'google_maps',
      q: placeName,
      type: 'search',
      api_key: process.env.SERP_API_KEY,
    };

    const response = await axios.get('https://serpapi.com/search', { params });
    
    
    if (response.data.local_results?.length > 0) {
      const place = response.data.local_results.find(p => 
        p.title.toLowerCase().includes(placeName.toLowerCase())
      );
      if (place?.place_id) {
        placeIdCache.set(cacheKey, place.place_id);
        return place.place_id;
      }
    }

   
    if (response.data.place_results?.place_id) {
      placeIdCache.set(cacheKey, response.data.place_results.place_id);
      return response.data.place_results.place_id;
    }

    return null;
  } catch (error) {
    console.error('Error fetching place ID:', error.message);
    return null;
  }
};


app.get('/api/suggestions', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  if (isGoogleMapsUrl(query)) {
    return res.json([]);
  }

  try {
    const params = {
      engine: 'google_maps',
      q: query.trim(),
      type: 'search',
      api_key: process.env.SERP_API_KEY,
    };

    const response = await axios.get('https://serpapi.com/search', { params });
    
    let suggestions = [];

    if (response.data.local_results) {
      suggestions = response.data.local_results.map(place => ({
        title: place.title || 'Unknown',
        address: place.address || 'Address not available',
        place_id: place.place_id || null,
      }));
    }

    if (response.data.place_results) {
      suggestions.push({
        title: response.data.place_results.title || 'Unknown',
        address: response.data.place_results.address || 'Address not available',
        place_id: response.data.place_results.place_id || null,
      });
    }

    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching suggestions:', error.message);
    res.status(500).json({ error: 'Error fetching suggestions' });
  }
});


app.post('/api/reviews', async (req, res) => {
  const { placeId } = req.body;

  if (!placeId) {
    return res.status(400).json({ error: 'Place name or URL is required' });
  }

  try {
    
    const resolvedPlaceId = await getPlaceId(placeId);
    if (!resolvedPlaceId) {
      return res.status(400).json({ error: 'Could not find this place' });
    }

   
    const params = {
      engine: 'google_maps_reviews',
      place_id: resolvedPlaceId,
      api_key: process.env.SERP_API_KEY,
      hl: 'en'
    };

    const response = await axios.get('https://serpapi.com/search', { params });
    
    const reviews = response.data.reviews || [];
    const placeInfo = response.data.place_info || null;

    if (reviews.length === 0) {
      return res.json({
        reviews: [],
        place_info: placeInfo,
        message: 'No reviews found for this place',
      });
    }

    
    const formattedReviews = reviews.map(review => ({
      author: review.user?.name || 'Anonymous',
      rating: review.rating || 0,
      text: review.snippet || 'No review text available',
      time: review.date || 'Date not available',
      business: placeInfo?.title || 'Unknown Business',
    }));

   
    try {
      await Review.insertMany(formattedReviews, { ordered: false });
    } catch (mongoError) {
      if (mongoError.code !== 11000) {
        console.error('MongoDB insert error:', mongoError);
      }
    }

    res.json({
      reviews: formattedReviews,
      place_info: placeInfo,
      total_reviews: formattedReviews.length
    });

  } catch (error) {
    console.error('Error fetching reviews:', error.message);
    res.status(500).json({ 
      error: 'Error fetching reviews', 
      details: error.message 
    });
  }
});


app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
