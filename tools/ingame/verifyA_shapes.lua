-- PhySim in-game verification A: shapes (drawCircle / drawLine / drawTriangleF)
-- Wire a monitor (3x3 or larger) video <- MC, and its composite output -> MC input.
-- Tap right half = next page / left half = previous page. "A<n>" shown top-left.
-- Green rulers on top and left edges: 1px every 5px, 2px every 10px.
S=screen
P=1
N=6
q=false

function onTick()
  local t=input.getBool(1)
  if t and not q then
    P=(P-1+(input.getNumber(3)>input.getNumber(1)/2 and 1 or -1))%N+1
  end
  q=t
  -- Fallback: a dial on number ch32 selects the page directly
  local n=input.getNumber(32)
  if n>=1 then P=math.min(N,math.floor(n)) end
end

function R()
  S.setColor(0,90,0)
  for x=0,S.getWidth()-1,5 do S.drawRectF(x,0,1,x%10==0 and 2 or 1) end
  for y=0,S.getHeight()-1,5 do S.drawRectF(0,y,y%10==0 and 2 or 1,1) end
  S.drawText(4,3,"A"..P)
  S.setColor(255,255,255)
end

function onDraw()
  S.setColor(0,0,0)
  S.drawClear()
  R()

  if P==1 then
    -- Segment count, start angle, winding direction. A 16-gon regardless of radius?
    S.drawCircle(48,52,22)

  elseif P==2 then
    -- Shift the centre by half a pixel: how does it move relative to P1 (round or floor)?
    S.drawCircle(48.5,52.5,22)

  elseif P==3 then
    -- Top row: outline r=1..7  middle row: filled r=1..7
    -- A 16-gon has side length 0.39*r. If sides under 1px are dropped, outlines with r<=2.5 vanish.
    local x=5
    for r=1,7 do
      S.drawCircle(x,20,r)
      S.drawCircleF(x,44,r)
      x=x+r*2+3
    end
    -- Bottom row: right at the threshold (0.39*2.5=0.975 / 0.39*2.6=1.014)
    local t={2.4,2.5,2.6,2.7,3}
    for i=1,5 do S.drawCircle(i*14-4,70,t[i]) end

  elseif P==4 then
    -- How fractional endpoints are rounded. Short vertical ticks are the integer reference, the long line is under test.
    local f={0,.25,.5,.75,-.25}
    for i=1,5 do
      local b=i*16-8
      S.setColor(0,90,0) S.drawRectF(b,20,1,6)
      S.setColor(255,255,255) S.drawLine(b+f[i],30,b+f[i],56)
    end
    -- Same thing in Y. The short horizontal ticks on the right are the integer reference.
    for i=1,5 do
      local b=i*6+54
      S.setColor(0,90,0) S.drawRectF(70,b,6,1)
      S.setColor(255,255,255) S.drawLine(20,b+f[i],60,b+f[i])
    end

  elseif P==5 then
    -- Left: horizontal lines of length 0..2px. Where do they start, and how many pixels?
    local L={0,.3,.5,.7,.9,1,1.1,1.5,2}
    for i=1,9 do
      local y=i*6+10
      S.setColor(0,90,0) S.drawRectF(6,y,1,1)
      S.setColor(255,255,255) S.drawLine(12,y,12+L[i],y)
    end
    -- Right: diagonals. Tells whether the length test is dx^2+dy^2 or per axis
    -- (.8,.8) has a diagonal length of 1.13 but an axis length of 0.8.
    local d={{.8,.8},{.6,.6},{.9,.4},{1.2,0},{.7,.7}}
    for i=1,5 do
      local y=i*8+16
      S.setColor(0,90,0) S.drawRectF(56,y,1,1)
      S.setColor(255,255,255) S.drawLine(62,y,62+d[i][1],y+d[i][2])
    end

  else
    -- Filled-triangle edge rule (only pixels whose centre is inside, or spill over?)
    S.drawTriangleF(6.5,12.25,46.75,26.5,18,60.125)
    S.drawTriangle(52,12,92,26,64,60)
    -- The same right triangle at integer and +0.5. Compare each row's width.
    S.drawTriangleF(50,68,70,68,50,88)
    S.drawTriangleF(10.5,68.5,30.5,68.5,10.5,88.5)
  end
end
