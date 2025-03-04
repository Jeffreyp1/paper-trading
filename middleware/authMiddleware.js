import jwt from 'jsonwebtoken';
import 'dotenv/config';

const SECRET_KEY = process.env.JWT_SECRET;

const authenticateToken = (req, res, next)=>{
    const authHeader = req.headers['authorization']
    const token = authHeader && authHeader.split(' ')[1]
    // check if we have a token first
    if (!token) return res.status(401).json({error:"Access Denied. No Token"})
    // token exists but now let's check if it's still valid
    jwt.verify(token, SECRET_KEY, (err,user)=>{
        if (err) {
            console.log("JWT Verification Error:", err.message); // ✅ Debugging: Show verification errors
            return res.status(403).json({ error: "Invalid or expired token" });
        }
        console.log("Decoded JWT User", user)
        req.user = user // Attach user info to the request object
        next() // continue to the next middleware or controlelr
    })
}
export default authenticateToken