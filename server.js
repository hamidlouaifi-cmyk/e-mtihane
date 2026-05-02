const express = require('express');
const app = express();

app.use(express.json({limit:'10mb'}));
app.use(function(req,res,next){
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type');
  res.header('Access-Control-Allow-Methods','POST,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', function(req,res){res.json({status:'ok',service:'e-mtihane proxy'});});

app.post('/grade', async function(req,res){
  try{
    var {prompt}=req.body;
    if(!prompt) return res.status(400).json({error:'No prompt'});
    var response=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key':process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body:JSON.stringify({
        model:'claude-haiku-4-5-20251001',
        max_tokens:800,
        messages:[{role:'user',content:prompt}]
      })
    });
    var data=await response.json();
    if(!response.ok) return res.status(500).json({error:data.error||'API error'});
    res.json({text:data.content[0].text});
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

var PORT=process.env.PORT||3000;
app.listen(PORT,function(){console.log('e-mtihane proxy running on port '+PORT);});
