-- PhySim in-game verification G: which way a vertex exactly half-way
-- between two 1/256px steps rounds. F3 found the Apple M5 rounding every
-- such tie up and the RTX 4070Ti going either way.
-- Same wiring as A-F: monitor video <- MC, monitor composite -> MC.
-- Tap right half = next page, left half = previous. Page shown top-left.
-- number ch32 (dial) jumps straight to a page.
-- Green rulers on top, bottom and left edges: 1px every 5, 2px every 10.
-- G1 and G2 fit themselves to the monitor: shoot them on every size you
-- have. G3 needs a monitor at least 64 high.
-- tools/ingame/analysis/ties.mjs reads the answers back out of a shot.
S=screen
P=1
N=3
q=false
W=96
H=96
-- half a 1/256px step: the tie
t=1/512

function onTick()
  local b=input.getBool(1)
  if b and not q then
    P=(P-1+(input.getNumber(3)>input.getNumber(1)/2 and 1 or -1))%N+1
  end
  q=b
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
  S.drawText(4,3,"G"..P)
  S.setColor(255,255,255)
end

function onDraw()
  W=S.getWidth()
  H=S.getHeight()
  S.setColor(0,0,0)
  S.drawClear()
  R()

  if P==1 then
    -- x = k + 1/512 for every column k. Each probe lights column k or
    -- nothing, so one row of the shot reads as one bit per value.
    for k=3,W-3 do
      -- a: drawRectF left edge (col k lit if it rounds down)
      S.drawRectF(k+t,8,.5,3)
      -- b: drawRectF right edge (col k lit if it rounds up)
      S.drawRectF(k-.5,12,.5+t,3)
      -- c: drawTriangleF vertical edge (col k lit if down)
      S.drawTriangleF(k+t,16,k+t,19,k+t+.5,19)
      -- d: a again, lower down: does the answer depend on y?
      S.drawRectF(k+t,H-7,.5,3)
    end
    -- e: F3's own rectangle, 4 wide with both edges on ties, one row per
    -- k mod 5 so neighbours don't touch. Col k-4 lit if the left edge
    -- rounds down, col k if the right edge rounds up.
    for k=7,W-3 do S.drawRectF(k-4+t,20+k%5,4,1) end

  elseif P==2 then
    -- y = k - 1/512 for every row: the same probes turned on their side.
    -- A y tie only shows just below a whole number (fills take rows
    -- floor(y)..), so the tie sits at k - 1/512 and decides row k-1.
    for k=11,H-3 do
      -- a: drawRectF top edge (row k-1 lit if down)
      S.drawRectF(4,k-t,3,.5)
      -- b: drawRectF bottom edge (row k-1 lit if up)
      S.drawRectF(8,k-.5,3,.5-t)
      -- c: drawTriangleF horizontal bottom edge (row k-1 lit if up)
      S.drawTriangleF(12,k-t-.5,12,k-t,15,k-t)
      -- d: a again, further right: does the answer depend on x?
      S.drawRectF(W-6,k-t,3,.5)
    end
    -- e: F3's rectangle stood up, 4 high. Row k-5 lit if the top edge
    -- rounds down, row k-1 if the bottom edge rounds up.
    for k=15,H-3 do S.drawRectF(17+k%5,k-4-t,1,4) end

  else
    -- drawCircleF r=3 (an octagon) with its left vertex on k + 1/512:
    -- pixel (k, cy) lit if it rounds down; the right vertex is on
    -- k+6 + 1/512, and (k+6, cy) lit if that rounds up. Row b holds
    -- k = 3+b, 15+b, 27+b, ..., so the six rows cover every value from
    -- 3 to W-7 (G1 has the last few).
    for b=0,5 do
      local cy=13+b*8
      for k=3+b,W-7,12 do S.drawCircleF(k+3+t,cy,3) end
    end
  end
end
