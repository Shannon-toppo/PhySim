-- PhySim in-game verification C: pinning down the drawCircle algorithm
-- In game, r=1..7 matched a midpoint circle, and neither model reproduced r=22.
-- Step the radius to find where they stop matching and the rule at large radii.
-- Wiring and controls as in A. Tap right half = next / left half = previous. "C<n>" top-left.
-- Green rulers on top, bottom and left edges: 1px every 5px, 2px every 10px.
S=screen
P=1
N=9
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
  S.drawText(4,3,"C"..P)
  S.setColor(255,255,255)
end

-- One per quadrant. Centres (25,25) (70,25) (25,70) (70,70).
-- With r<=22 neighbours don't overlap.
function G(a,b,c,d,fill)
  local v={{25,25,a},{70,25,b},{25,70,c},{70,70,d}}
  for i=1,4 do
    if fill then S.drawCircleF(v[i][1],v[i][2],v[i][3])
    else S.drawCircle(v[i][1],v[i][2],v[i][3]) end
  end
end

function onDraw()
  S.setColor(0,0,0)
  S.drawClear()
  R()

  if P==1 then G(8,9,10,11)          -- does it match a midpoint circle?
  elseif P==2 then G(12,13,14,15)
  elseif P==3 then G(16,17,18,19)
  elseif P==4 then G(20,21,22,22)    -- bottom-right is r=22 too (reference for P5's centre shifts)
  elseif P==5 then
    -- Same r=22, only the centre's fractional part changes
    S.drawCircle(25.25,25,22)
    S.drawCircle(70.5,25,22)
    S.drawCircle(25,70.5,22)
    S.drawCircle(70.75,70.75,22)
  elseif P==6 then
    -- Does the radius' fractional part affect the shape? (A3: r=2.6 and 2.7 looked identical)
    G(15,15.25,15.5,15.75)
  elseif P==7 then S.drawCircle(48,48,32)   -- one large radius
  elseif P==8 then S.drawCircle(48,48,44)   -- fills the screen
  else G(12,13,14,15,true)                  -- do fills follow the same rule as outlines?
  end
end
