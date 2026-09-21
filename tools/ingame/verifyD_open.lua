-- PhySim in-game verification D: the questions A/B/C left open.
-- Same wiring as A/B/C: monitor video <- MC, monitor composite -> MC.
-- Tap right half = next page, left half = previous. Page shown top-left.
-- number ch32 (dial) jumps straight to a page.
-- Green rulers on top, bottom and left edges: 1px every 5, 2px every 10.
-- Layout assumes a 96x96 (3x3) monitor. One screenshot per page, D1..D12.
S=screen
P=1
N=12
q=false

function onTick()
  local t=input.getBool(1)
  if t and not q then
    P=(P-1+(input.getNumber(3)>input.getNumber(1)/2 and 1 or -1))%N+1
  end
  q=t
  local n=input.getNumber(32)
  if n>=1 then P=math.min(N,math.floor(n)) end
end

function R()
  S.setColor(0,90,0)
  local w,h=S.getWidth(),S.getHeight()
  for x=0,w-1,5 do
    local b=x%10==0 and 2 or 1
    S.drawRectF(x,0,1,b)
    S.drawRectF(x,h-2,1,b)
  end
  for y=0,h-1,5 do S.drawRectF(0,y,y%10==0 and 2 or 1,1) end
  S.drawText(4,3,"D"..P)
  S.setColor(255,255,255)
end

-- one outline circle per quadrant, centres (25,25) (70,25) (25,70) (70,70)
function G(a,b,c,d)
  S.drawCircle(25,25,a) S.drawCircle(70,25,b)
  S.drawCircle(25,70,c) S.drawCircle(70,70,d)
end

-- cells of a 4x4 grid for small shapes: column i, row j (1..4)
function X(i) return i*21-8 end
function Y(j) return j*20-6 end

function onDraw()
  if P~=9 then
    S.setColor(0,0,0)
    S.drawClear()
  end
  R()

  if P==1 then
    -- (retake of C5) r=22, centre fraction .25 / .5 / .5(y) / .75
    S.drawCircle(25.25,25,22)
    S.drawCircle(70.5,25,22)
    S.drawCircle(25,70.5,22)
    S.drawCircle(70.75,70.75,22)

  elseif P==2 then
    -- side count cap: floor(r/2) would give 17, 19, 21 sides
    S.drawCircle(48,48,34)
    S.drawCircle(48,48,38)
    S.drawCircle(48,48,42)

  elseif P==3 then
    -- fractional radius: floor(r/2) gives 8,8,9,9 sides, round gives 9,9,10,10
    G(17.5,17.9,19.5,19.9)

  elseif P==4 then
    -- vertex order (clockwise or not): each of these differs by one pixel
    local o={{0,.5},{.25,.25},{.5,0},{.75,.75}}
    for i=1,4 do
      for j=1,4 do
        S.drawCircle(X(i)+2+o[j][1],Y(j)+2+o[j][2],3+i)
      end
    end

  elseif P==5 then
    -- 45 degree lines through diamond corners: is a diagonal x-major or y-major?
    local d={{1,-1},{-1,1},{-1,-1},{1,1}}
    local o={{0,.5},{.25,.25},{.5,0},{.75,.25}}
    for i=1,4 do
      for j=1,4 do
        local x,y=X(i)+o[j][1],Y(j)+o[j][2]
        local L=j+1
        S.drawLine(x,y,x+d[i][1]*L,y+d[i][2]*L)
      end
    end

  elseif P==6 then
    -- endpoints 1/1024 off a tie: does the GPU snap to 1/256 px?
    local e=1/1024
    local c={
      {e,.5,4+e,.5},{0,.5,4+e,.5},{.5,e,.5,4+e},{.5+e,0,.5+e,4},
      {.5,0,.5+e,4},{e,0,2+e,1},{0,0,2+e,1},{e,0,1+e,2},
      {0,0,1+e,2},{e,.5,3+e,1.5},{0,.5,3+e,1.5},{0,.5-e,4,.5-e},
      {0,-e,2,1-e},{0,-e,1,2-e},{-e,0,.5-e,0},{0,0,.5-e,0}}
    for k=1,16 do
      local i,j=(k-1)%4+1,(k-1)//4+1
      local v=c[k]
      S.drawLine(X(i)+v[1],Y(j)+v[2],X(i)+v[3],Y(j)+v[4])
    end

  elseif P==7 then
    -- drawRectF: fractional y, negative sizes. Green dots mark integer y.
    local f={0,.25,.5,.75}
    for i=1,4 do
      local x=i*20-12
      S.setColor(0,90,0) S.drawRectF(x-3,20,1,1) S.drawRectF(x-3,27,1,1)
      S.setColor(255,255,255) S.drawRectF(x,20+f[i],6,6.5)
    end
    S.drawRectF(14,44,-6,6)
    S.drawRectF(28,50,6,-6)
    S.drawRectF(48,50,-6,-6)
    S.drawRectF(58.5,44.5,-4,-4)
    -- drawRect: fractional y and negative sizes
    for i=1,4 do S.drawRect(i*20-12,62+f[i],6,6) end
    S.drawRect(14,78,-6,6)
    S.drawRect(28,84,6,-6)
    S.drawRect(48,84,-6,-6)
    S.drawRect(58.5,78.5,-4,-4)

  elseif P==8 then
    -- drawTriangleF: fractional y, both windings, and a rectangle as two
    -- triangles next to the same drawRectF
    local f={0,.25,.5,.75}
    for i=1,4 do
      local x,y=i*20-12,12+f[i]
      S.drawTriangleF(x,y,x+10,y,x,y+10)
      S.drawTriangleF(x+10,y+22,x,y+22,x,y+12)
    end
    S.drawTriangleF(8,50.5,24,50.5,8,58.5)
    S.drawTriangleF(24,50.5,24,58.5,8,58.5)
    S.drawRectF(30,50.5,16,8)
    S.drawTriangleF(52.25,48.25,70.5,63.75,55.5,70.25)
    S.drawTriangleF(76.25,70.25,91.5,48.75,94,66.5)
    S.drawTriangleF(8,66,24,66,8,66)
    S.drawTriangleF(30,74.5,46,86.5,30.5,90.25)

  elseif P==9 then
    -- no drawClear on this page. What is a pixel before the first draw?
    -- top: opaque black first, then white a=128 (known: shows 96)
    -- bottom: white a=128 straight onto the fresh frame
    -- If the bottom creeps brighter over time, frames are not cleared.
    S.setColor(0,0,0) S.drawRectF(2,10,94,36)
    S.setColor(255,255,255,128)
    S.drawRectF(10,14,30,28)
    S.drawRectF(56,50,30,28)
    S.setColor(255,255,255,32)
    S.drawRectF(56,14,30,28)
    S.drawRectF(10,50,30,28)

  elseif P==10 then
    -- every printable ASCII character, 18 per row, from x=3
    local s=""
    for c=32,126 do s=s..string.char(c) end
    for r=0,5 do S.drawText(3,10+r*6,s:sub(r*18+1,r*18+18)) end
    -- fractional and negative text positions
    S.drawText(-0.5,50,"ABC")
    S.drawText(3.5,56,"ABC")
    S.drawText(3.75,62,"ABC")
    S.drawText(3,68.5,"ABC")
    S.drawText(3,74.75,"ABC")
    S.drawText(40,49.5,"ABC")
    S.drawText(40.25,56.25,"ABC")

  elseif P==11 then
    -- drawTextBox. Green dots mark each box's top-left and bottom-right.
    local b={
      {3,11,44,9,"ab",0,0},
      {52,11,24,20,"abcdefghijkl",-1,-1},
      {3,24,44,20,"ab\ncd ef",-1,-1},
      {52,34,40,13,"right al",1,1},
      {3,50,44,20,"a  b    c d",0,-1},
      {52,50,44,20,"abcdefgh ij",-1,-1},
      {3,74,45,14,"wrap this box",-1,-1},
      {52,74,49,14,"wrap this box",-1,-1}}
    for i=1,8 do
      local v=b[i]
      S.setColor(0,90,0)
      S.drawRectF(v[1]-1,v[2]-1,1,1)
      S.drawRectF(v[1]+v[3],v[2]+v[4],1,1)
      S.setColor(255,255,255)
      S.drawTextBox(v[1],v[2],v[3],v[4],v[5],v[6],v[7])
    end

  else
    -- odds and ends: zero-length line, negative radius, tiny circles,
    -- zero-area triangles, a line far off screen
    S.drawLine(10,12,10,12)
    S.drawLine(20,12,20.3,12.3)
    S.drawCircle(25,30,-10)
    S.drawCircleF(60,30,-8)
    local r={0.3,0.5,0.8,1.2,1.5}
    for i=1,5 do
      S.drawCircle(i*14-2,52,r[i])
      S.drawCircleF(i*14-2,62,r[i])
    end
    S.drawTriangleF(10,74,30,74,20,74)
    S.drawTriangleF(40,72,50,82,60,92)
    S.drawLine(-1e9,86,1e9,88)
    S.drawLine(80,-1e9,82,1e9)
  end
end
