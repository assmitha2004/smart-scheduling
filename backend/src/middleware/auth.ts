import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
export interface AuthedRequest extends Request { userId?: string }
export function requireAuth(req: AuthedRequest,res:Response,next:NextFunction){const token=req.headers.authorization?.replace(/^Bearer\\s+/i,'');if(!token)return res.status(401).json({error:'Authentication required'});try{req.userId=(jwt.verify(token,process.env.JWT_SECRET||'dev-only-change-me') as jwt.JwtPayload).sub;next();}catch{return res.status(401).json({error:'Invalid or expired token'});}}