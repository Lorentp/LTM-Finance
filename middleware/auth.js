const jwt = require('jsonwebtoken');
module.exports = (req,res,next) => {
  const token=req.cookies?.ltm_token;
  if(!token)return res.status(401).json({error:'Sesión no iniciada'});
  try{req.user=jwt.verify(token,process.env.JWT_SECRET||'cambiar-esta-clave-en-vercel');next();}
  catch{return res.status(401).json({error:'Sesión vencida'});}
};
