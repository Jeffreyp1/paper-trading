import {WebSocketServer} from "ws";
import redis from './redis.js'
const wss = new WebSocketServer({port: 8080})

wss.on('connection', async (ws)=>{
    console.log("New WebSocket Connection");
    ws.send(JSON.stringify({message: "Connected to live updates"}));
      const start = Date.now();
      redis.hGetAll("stockPrices").then(stockData=>{
        wss.clients.forEach(client =>{
            if(client.readyState === 1){
                client.send(JSON.stringify({type:"stocks", data: stockData}))
            }
        })
        })
      const redisData = await redis.zRangeWithScores("leaderboard", -10, -1,"WITHSCORES");
      const formattedLeaderboard = redisData.reverse().map(entry => {
          const userData = JSON.parse(entry.value);
          return{
              username: userData.username,
              net_worth: entry.score,
              holdings: userData.holdings
          };
      });
  
      const end = Date.now();
      console.log(`leaderboard API Response Time: ${end - start}ms`);
      ws.send(JSON.stringify({type:"ledaerboard", data: formattedLeaderboard}))
      ws.on("close", ()=>{
          console.log("User disconnected")
      })
  })
export async function pushLeaderboard(){
    const redisData = await redis.zRangeWithScores("leaderboard", -10, -1, "WITHSCORES"); 
        // const redisData = await redis.zRangeWithScores("leaderboard", -10, -1, "WITHSCORES");
        // const redisData = await redis.zRangeWithScores("leaderboard", 0, 9, { REV: true });
    const formattedLeaderboard = redisData.reverse().map(entry => {
        const userData = JSON.parse(entry.value);
        return{
            username: userData.username,
            net_worth: entry.score,
            holdings: userData.holdings
        };
    });
    wss.clients.forEach(client=>{
        if (client.readyState === 1){
            client.send(JSON.stringify({type:"leaderboard", data: formattedLeaderboard}))
        }
    })
    console.log("Leaderboard update sent to WebSocket Clients")
}
export function pushStockPrices(){
    redis.hGetAll("stockPrices").then(stockData=>{
        wss.clients.forEach(client =>{
            if(client.readyState === 1){
                client.send(JSON.stringify({type:"stocks", data: stockData}))
            }
        })
    })
}
export default wss