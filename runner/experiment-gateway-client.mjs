// Runs in the container. Forward local HTTP over the one mounted Unix socket;
// the host validates every route and injects only granted Git credentials.
import { createServer, request } from 'node:http';
createServer((req,res)=>{
  const upstream=request({socketPath:'/opt/experiment-gateway/relay.sock',path:req.url,method:req.method,headers:req.headers},reply=>{
    res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
  });
  upstream.on('error',()=>{res.writeHead(502);res.end('Group transport unavailable');});req.pipe(upstream);
}).listen(Number(process.argv[2]),'127.0.0.1');
