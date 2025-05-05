import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors({
  origin: 'https://scrap-frontend.vercel.app',
  credentials: true,
}));
app.use(express.json());

// MongoDB Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected successfully'))
  .catch(err => console.error('MongoDB connection error:', err));

// Review Schema
const reviewSchema = new mongoose.Schema({
  author: { type: String, required: true },
  rating: { type: Number, required: true },
  text: { type: String, required: true },
  time: { type: String },
  business: { type: String },
});

const Review = mongoose.model('Review', reviewSchema);

// Autocomplete Suggestions
app.get('/api/suggestions', async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const response = await axios.get('https://serpapi.com/search', {
      params: {
        engine: 'google_maps',
        q: query,
        type: 'search',
        api_key: process.env.SERP_API_KEY,
      },
    });

    const suggestions = (response.data.local_results || []).map(place => ({
      title: place.title,
      address: place.address,
      place_id: place.place_id,
    }));

    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching suggestions:', error.message);
    res.status(500).json({ error: 'Error fetching suggestions' });
  }
});

// Scrape Reviews
app.post('/api/reviews', async (req, res) => {
  const { placeId } = req.body;

  if (!placeId) {
    return res.status(400).json({ error: 'Place ID or URL is required' });
  }

  try {
    const params = {
      engine: 'google_maps_reviews',
      api_key: process.env.SERP_API_KEY,
      hl: 'en',
    };

    if (placeId.startsWith('https://')) {
      params.url = placeId;
    } else {
      params.place_id = placeId;
    }

    const response = await axios.get('https://serpapi.com/search', { params });
    const reviews = (response.data.reviews || []).slice(0, 10).map(review => ({
      author: review.user.name || 'Anonymous',
      rating: review.rating || 0,
      text: review.snippet || 'No review text available.',
      time: review.date || 'Date not available',
      business: response.data.place_info?.title || 'Unknown Business',
    }));

    if (reviews.length < 5) {
      return res.status(404).json({ error: 'Not enough reviews found' });
    }

    // Save reviews to MongoDB
    try {
      await Review.insertMany(reviews, { ordered: false });
    } catch (mongoError) {
      if (mongoError.code !== 11000) {
        throw mongoError;
      }
    }

    res.json(reviews);
  } catch (error) {
    console.error('Error fetching reviews:', error.message, error.stack);
    res.status(500).json({ error: 'Error fetching reviews', details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
