import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "incidentiq-dev-secret";

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }
  const token = header.split(" ")[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token expired or invalid" });
  }
}

export function generateToken(user) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "24h" });
}