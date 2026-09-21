-- PhySim in-game verification E: monitors other than 3x3, and how a
-- negative radius enters the circle's side count.
-- Same wiring as A-D: monitor video <- MC, monitor composite -> MC.
-- Tap right half = next page, left half = previous. Page shown top-left.
-- number ch32 (dial) jumps straight to a page.
-- Green rulers on top, bottom and left edges: 1px every 5, 2px every 10.
-- E1-E4 fit themselves to the monitor: shoot them on every size you have
-- (1x1, 2x1, 2x2, 3x2, 3x3, 5x3, 9x5). E5-E7 assume 96x96 (3x3).
S=screen
P=1
N=7
q=false
W=96
H=96

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
  for x=0,W-1,5 do
    local b=x%10==0 and 2 or 1
    S.drawRectF(x,0,1,b)
    S.drawRectF(x,H-2,1,b)
  end
  for y=0,H-1,5 do S.drawRectF(0,y,y%10==0 and 2 or 1,1) end
  S.drawText(4,3,"E"..P)
  S.setColor(255,255,255)
end

-- One probe block, 30x21, of rules that hinge on a tie. Every block is
-- drawn at a whole-pixel offset, so all copies must come out identical;
-- one that differs means the rules depend on where you are on the screen.
function B(x,y)
  -- band 1 (rows 0-4)
  S.drawLine(x,y+.5,x+4,y+.5)        -- y .5 -> lower row: row 1
  S.drawLine(x,y+3.75,x+4,y+3.75)    -- row 4
  S.drawLine(x+6.5,y,x+6.5,y+5)      -- x .5 -> left column: col 6
  S.drawLine(x+8.75,y,x+8.75,y+5)    -- col 9
  S.drawLine(x+11.5,y,x+11.5,y+5)    -- col 11
  S.drawLine(x+14,y+1,x+14.5,y+1)    -- 0.5px: one pixel
  S.drawLine(x+16,y+1,x+16.3,y+1)    -- 0.3px: nothing
  S.drawLine(x+18,y+1,x+18.3,y+1.3)  -- short diagonal leaves: one pixel
  S.drawLine(x+21,y+3.5,x+21,y+.5)   -- up from a top corner: rows 2-4
  S.drawLine(x+24,y+.5,x+24,y+3.5)   -- down from a bottom corner: rows 1-3
  S.drawLine(x+26,y,x+29,y+3)        -- 45 degrees
  -- band 2 (rows 7-12)
  S.drawRectF(x+.5,y+7.5,3,3)        -- cols 1-3, rows 7-9
  S.drawRect(x+5.5,y+7.5,3,3)        -- cols 5-8, rows 8-11
  S.drawTriangleF(x+11,y+7,x+17,y+7,x+11,y+13)
  S.drawCircleF(x+22,y+10,3)         -- left vertex in, right vertex out
  -- band 3 (rows 14-20)
  S.drawCircle(x+3,y+17,3)
  S.drawText(x+9.5,y+15,"AB")        -- floored to x+9
  S.drawLine(x+20.25,y+14.5,x+29,y+20.25)
end

-- one circle per quadrant, centres (25,25) (70,25) (25,70) (70,70)
function G(f,a,b,c,d)
  f(25,25,a) f(70,25,b)
  f(25,70,c) f(70,70,d)
end

function onDraw()
  W=S.getWidth()
  H=S.getHeight()
  S.setColor(0,0,0)
  S.drawClear()
  R()

  if P==1 then
    -- the monitor's own edges. The size is printed so the shot records it.
    S.drawText(4,10,string.format("%dX%d",W,H))
    -- right edge
    S.drawLine(W-1,9,W-1,13)         -- col W-1, rows 9-12
    S.drawLine(W-.5,15,W-.5,19)      -- x .5 goes left: col W-1
    S.drawLine(W,21,W,25)            -- col W is off screen: nothing
    S.drawRectF(W-2.5,27,3,2)        -- cols W-2..W-1, rows 27-28
    S.drawText(W-7,21,"AB")          -- B cut after 2 columns
    -- bottom edge
    S.drawLine(4,H-1,8,H-1)          -- row H-1
    S.drawLine(10,H-.5,14,H-.5)      -- y .5 goes down: row H, nothing
    S.drawLine(16,H-.75,20,H-.75)    -- row H-1
    S.drawRectF(22,H-1.5,3,3)        -- rows H-2..H-1

  elseif P==2 then
    -- probe blocks tiled over the whole screen, 32 apart across, 23 down
    for y=9,H-23,23 do
      for x=2,W-30,32 do B(x,y) end
    end

  elseif P==3 then
    -- long shallow lines across the full width: a mapping that is off by
    -- a fraction of a pixel per screen shows up as a moved step
    local i=0
    while 10+i*5<=H-6 do
      S.drawLine(2,10+i*5+i/8,W-1,12.5+i*5)
      i=i+1
    end

  elseif P==4 then
    -- circles packed in shelves, as many as fit, 18-22 first. Sides on 3x3:
    -- 8 up to r=17, then 9,10,11 at 18,20,22 ... 16 from r=32
    local r={22,20,18,17,13,9,7,3,26,30,34,44}
    local x,y,h=2,9,0
    for i=1,#r do
      local d=2*r[i]+3
      local a,b,c=x,y,h
      if a+d>W then a,b,c=2,b+c,0 end
      if b+d<=H-2 then
        S.drawCircle(a+r[i]+1,b+r[i]+1,r[i])
        x,y,h=a+d,b,math.max(c,d)
      end
    end

  elseif P==5 then
    -- negative radii, outline. Sides if the count uses
    -- r itself / |r| / |floor(r/2)|:   -22: 8/11/11  -18: 8/9/9
    --                                  -19: 8/9/10   -21: 8/10/11
    -- An odd count also shows whether the vertices use r (pointing
    -- left) or |r| (pointing right, like A1).
    G(S.drawCircle,-22,-18,-19,-21)

  elseif P==6 then
    -- the same radii filled
    G(S.drawCircleF,-22,-18,-19,-21)

  else
    -- large negative radii, concentric. Sides as on E5:
    -- -44 and -32: 8/16/16, -26: 8/13/13 (odd: shows the vertex sign)
    S.drawCircle(48,48,-44)
    S.drawCircle(48,48,-32)
    S.drawCircle(48,48,-26)
  end
end
