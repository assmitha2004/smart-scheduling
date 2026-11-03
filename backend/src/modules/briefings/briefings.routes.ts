import { Router } from 'express';
import { currentUser } from '../../middleware/auth.js';
import { getDailyBriefing } from './briefings.service.js';

export const briefingsRouter = Router();

/** GET /briefings/daily?ai=true — today's priorities, blockers, deadlines and capacity. */
briefingsRouter.get('/daily', async (req, res) => {
  res.json(await getDailyBriefing(currentUser(req).id, { ai: req.query.ai === 'true' }));
});
