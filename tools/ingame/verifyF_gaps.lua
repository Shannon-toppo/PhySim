-- PhySim in-game verification F: what doc/monitor-rendering.md still fills
-- in by formula instead of by screenshot.
-- Same wiring as A-E: monitor video <- MC, monitor composite -> MC.
-- Tap right half = next page, left half = previous. Page shown top-left.
-- number ch32 (dial) jumps straight to a page.
-- Green rulers on top, bottom and left edges: 1px every 5, 2px every 10.
-- Layout assumes a 96x96 (3x3) monitor. One screenshot per page, F1..F9.
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
  S.drawText(4,3,"F"..P)
  S.setColor(255,255,255)
end

-- cells of a 4x4 grid for small shapes: column i, row j (1..4)
function X(i) return i*21-8 end
function Y(j) return j*20-6 end

-- one filled circle per quadrant, centres near (25,25) (70,25) (25,70) (70,70)
function G(v)
  for i=1,4 do S.drawCircleF(v[i][1],v[i][2],v[i][3]) end
end

-- sin of the angle whose vertices make a circle's horizontal edges:
-- 10 sides -> vertices 2,3 (72 and 108 deg), 14 sides -> 3,4
s10=math.sin(.4*math.pi)
s14=math.sin(6*math.pi/14)

function onDraw()
  if P==8 then
    -- the page's own clear, translucent orange: shows as (64,32,0)
    S.setColor(255,128,0,64)
  else
    S.setColor(0,0,0)
  end
  S.drawClear()
  R()

  if P==1 then
    -- side counts between the measured r=22 (11) and r=32 (16), odd radii.
    -- floor(r/2) gives 11,12,13,14,15,16
    for r=23,33,2 do S.drawCircle(48,48,r) end

  elseif P==2 then
    -- even radii, and fractions just under an odd number, where floor(r/2)
    -- and round(r/2) differ: 12,12,14,14,15 sides (round: 12,13,14,15,16)
    for _,r in ipairs({24,25.9,28,29.9,31.9}) do S.drawCircle(48,48,r) end

  elseif P==3 then
    -- do fills snap to 1/256 px like lines (D6)? Columns: offset 0, 1/1000,
    -- 1/512 (half a step), 1/300. Rows: drawRectF x, drawRectF y (offset
    -- subtracted), drawTriangleF's vertical edge, drawCircleF's left vertex.
    local e={0,1/1000,1/512,1/300}
    for i=1,4 do
      local x,y,d=X(i),Y(1),e[i]
      S.drawRectF(x+d,y,4,3)
      y=Y(2) S.drawRectF(x,y-d,4,3)
      y=Y(3) S.drawTriangleF(x+d,y,x+d,y+6,x+6+d,y+6)
      y=Y(4) S.drawCircleF(x+3+d,y+3,3)
    end
    -- radius 0, and outlined triangles with fractional corners
    S.drawCircle(10,87,0)
    S.drawCircleF(16,87,0)
    S.drawTriangle(24.25,83.5,33.75,85.25,27.5,91.75)
    S.drawTriangle(40.5,91.5,45.75,82.25,52.5,90.75)
    S.drawTriangle(60.75,82.5,72.25,83.25,61.5,86.5)

  elseif P==4 then
    -- D1's r=22 circles filled: centre fraction .25 / .5 / .5(y) / .75
    G({{25.25,25,22},{70.5,25,22},{25,70.5,22},{70.75,70.75,22}})

  elseif P==5 then
    -- 10-gons put a horizontal edge exactly on a row of sample points:
    -- bottom edge on row 44 / 90, top edge on row 6 / 51
    G({{25,44-20*s10,20},{70,6+20*s10,20},
       {25,90-21*s10,21},{70,51+21*s10,21}})

  elseif P==6 then
    -- a filled 14-gon larger than any fill so far, top edge on row 20
    S.drawCircleF(48,20+29*s14,29)
    -- lines from far off screen, steep and shallow, both directions
    S.drawLine(13.3,-1e9,14.6,1e9)
    S.drawLine(16,-1e6,18.5,1e6)
    S.drawLine(88.25,1e9,86,-1e9)
    S.drawLine(92,-1e5,90,1e5)
    S.drawLine(-1e9,10.3,1e9,12.6)
    S.drawLine(1e7,85,-1e7,86.5)
    S.drawLine(-1e6,-1e6-70.25,1e6,1e6-70.25)

  elseif P==7 then
    -- colour at a=128. Top: opaque ramps 0..255 step 51 (grey, R, G, B) to
    -- calibrate against in the same shot.
    for c=1,4 do
      for i=0,5 do
        local v=i*51
        S.setColor(c==1 and v or c==2 and v or 0,
          (c==1 or c==3) and v or 0,(c==1 or c==4) and v or 0)
        S.drawRectF(16+i*13,10+(c-1)*5,12,4)
      end
    end
    -- three bands: black, grey 128, white
    local bg={0,128,255}
    for b=1,3 do
      local y=32+(b-1)*20
      S.setColor(bg[b],bg[b],bg[b]) S.drawRectF(2,y,94,19)
      -- row 1: red, green, blue, orange, cyan at a=128
      local c={{255,0,0},{0,255,0},{0,0,255},{255,128,0},{0,255,255}}
      for i=1,5 do
        S.setColor(c[i][1],c[i][2],c[i][3],128)
        S.drawRectF(i*10-6,y+2,8,7)
      end
      -- row 2: opaque base, translucent colour over it
      local u={{0,0,255},{255,0,0},{0,255,0},{255,255,255},{128,128,128}}
      local o={{255,0,0,128},{0,255,0,128},{0,0,255,128},{255,0,0,64},{255,128,0,192}}
      for i=1,5 do
        S.setColor(u[i][1],u[i][2],u[i][3]) S.drawRectF(i*10-6,y+10,8,7)
        S.setColor(o[i][1],o[i][2],o[i][3],o[i][4]) S.drawRectF(i*10-4,y+10,4,7)
      end
      -- text and two crossing lines, white a=128 (the crossing blends twice)
      S.setColor(255,255,255,128)
      S.drawText(56,y+3,"AB")
      S.drawText(56,y+10,"a")
      S.drawLine(70,y+2,82,y+14)
      S.drawLine(82,y+2,70,y+14)
      S.drawCircle(89,y+9,5)
    end

  elseif P==8 then
    -- after the translucent clear: grey ramp for calibration, then white
    -- and black a=128 over the clear colour, an opaque red, and a=0
    for i=0,5 do
      local v=i*51
      S.setColor(v,v,v) S.drawRectF(8+i*13,14,12,10)
    end
    S.setColor(255,255,255,128) S.drawRectF(8,32,24,24)
    S.setColor(0,0,0,128) S.drawRectF(36,32,24,24)
    S.setColor(255,0,0) S.drawRectF(64,32,24,24)
    S.setColor(255,255,255,0) S.drawRectF(8,62,24,24)
    S.setColor(255,255,255,128) S.drawText(40,70,"A")

  else
    -- drawTextBox: the alignments D11 left out, trailing spaces when right
    -- aligned, fractional position, a box narrower than one glyph, and text
    -- taller than its box. Green dots mark each box's top-left (outside)
    -- and bottom-right.
    local b={
      {3,11,44,13,"ab",1,-1},
      {52,11,40,13,"ab",-1,1},
      {3,28,44,14,"ab",-1,0},
      {52,28,40,13,"ab",0,1},
      {3,45,44,14,"ab",1,0},
      {52,45,40,13,"ab  ",1,-1},
      {3.75,62.75,44,13,"ab",-1,-1},
      {52,62,4,13,"abc",-1,-1},
      {3,80,44,5,"one two three",0,0}}
    for i=1,9 do
      local v=b[i]
      S.setColor(0,90,0)
      S.drawRectF(v[1]-1,v[2]-1,1,1)
      S.drawRectF(v[1]+v[3],v[2]+v[4],1,1)
      S.setColor(255,255,255)
      S.drawTextBox(v[1],v[2],v[3],v[4],v[5],v[6],v[7])
    end
  end
end
