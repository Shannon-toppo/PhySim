-- PhySim in-game verification B: colour, alpha, rectangles, text (wiring and controls as in A)
S=screen
P=1
N=7
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
  -- Rulers on the bottom edge too. Without two, the screenshot's vertical axis can't be calibrated
  for x=0,S.getWidth()-1,5 do S.drawRectF(x,S.getHeight()-2,1,x%10==0 and 2 or 1) end
  S.drawText(4,3,"B"..P)
  S.setColor(255,255,255)
end

function onDraw()
  S.setColor(0,0,0)
  S.drawClear()
  R()

  if P==1 then
    -- Opaque grey 0..255 in steps of 17. The monitor's transfer curve.
    for i=0,15 do
      S.setColor(i*17,i*17,i*17)
      S.drawRectF(i*6+1,12,5,24)
    end
    -- Primaries in the same steps
    for i=0,15 do
      S.setColor(i*17,0,0) S.drawRectF(i*6+1,40,5,12)
      S.setColor(0,i*17,0) S.drawRectF(i*6+1,54,5,12)
      S.setColor(0,0,i*17) S.drawRectF(i*6+1,68,5,12)
    end

  elseif P==2 then
    -- White on black at a=0..255, then on grey (128)
    for i=0,15 do
      S.setColor(255,255,255,i*17)
      S.drawRectF(i*6+1,12,5,20)
    end
    S.setColor(128,128,128) S.drawRectF(1,40,95,20)
    for i=0,15 do
      S.setColor(255,255,255,i*17)
      S.drawRectF(i*6+1,40,5,20)
    end
    -- Black on white at a=0..255
    S.setColor(255,255,255) S.drawRectF(1,68,95,20)
    for i=0,15 do
      S.setColor(0,0,0,i*17)
      S.drawRectF(i*6+1,68,5,20)
    end

  elseif P==3 then
    -- a=128 overlaid n times. Does it accumulate?
    for n=1,5 do
      for _=1,n do
        S.setColor(255,255,255,128)
        S.drawRectF(n*17-10,12,14,24)
      end
    end
    -- Does a=0 really do nothing?
    S.setColor(255,255,255) S.drawRectF(1,44,95,24)
    S.setColor(0,0,0,0)     S.drawRectF(6,48,20,16)
    S.setColor(255,0,0,0)   S.drawRectF(36,48,20,16)
    S.setColor(0,0,0,8)     S.drawRectF(66,48,20,16)
    -- Low-alpha end. White a=1..128
    local a={1,2,4,8,16,32,64,128}
    for i=1,8 do
      S.setColor(255,255,255,a[i])
      S.drawRectF(i*12-11,74,11,14)
    end

  elseif P==4 then
    -- Does drawClear ignore alpha and replace?
    S.setColor(255,0,0) S.drawRectF(10,20,76,30)
    S.setColor(0,0,255) S.drawText(20,60,"UNDER")
    S.setColor(0,255,0,128) S.drawClear()
    S.setColor(255,255,255) S.drawText(4,3,"B4")

  elseif P==5 then
    -- Are the frame's four corners blended twice?
    S.setColor(255,255,255,128)
    S.drawRect(6,12,40,30)
    -- Degenerate: width 1 / height 1 / width 0 / 1x1
    S.drawRect(56,12,1,30)
    S.drawRect(62,12,30,1)
    S.drawRect(62,20,0,10)
    S.drawRect(62,26,1,1)
    -- Integer and fractional frames
    S.setColor(255,255,255)
    S.drawRect(6,52,20,20)
    S.drawRect(40.5,52.5,20,20)
    S.drawRect(70.25,52,20,20)

  elseif P==6 then
    -- drawRectF coordinate rule. Green dots mark x and x+w
    local c={{20,3},{20.5,3},{20.5,3.5},{20.25,3},{20.75,3},{19.5,3}}
    for i=1,6 do
      local y=i*13+2
      S.setColor(0,90,0)
      S.drawRectF(20,y-2,1,1)
      S.drawRectF(23,y-2,1,1)
      S.setColor(255,255,255)
      S.drawRectF(c[i][1],y,c[i][2],7)
    end
    -- Negative side and zero width
    S.setColor(255,255,255)
    S.drawRectF(-0.5,86,4,7)
    S.drawRectF(60,86,0,7)
    S.drawRectF(70,86,0.4,7)

  else
    -- Character advance, line advance, glyphs
    S.setColor(255,255,255)
    S.drawText(0,10,"ABCDEFGHIJKLMNOPQRST")
    S.drawText(0,16,"abcdefghijklmnopqrst")
    S.drawText(0,22,"0123456789.,:;!?-+=")
    S.drawText(0,28,"[]{}()<>|_^~#@$%&*/")
    S.drawText(0.5,36,"HALF X OFFSET")
    S.drawText(0,42.5,"HALF Y OFFSET")
    S.drawText(-3,50,"CLIPPED LEFT EDGE")
    S.drawTextBox(0,58,44,22,"wrap this box now please",0,0)
    S.drawTextBox(50,58,44,22,"centred text box",0,0)
  end
end
