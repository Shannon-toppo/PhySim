-- PhySim in-game verification H: what the game does when a script calls
-- input.* / output.* inside onDraw, or screen.* inside onTick.
-- Three outcomes are possible for each: the call works, it quietly
-- returns nothing (0 / false), or it is a Lua error that stops the script.
-- Same wiring as A-G: monitor video <- MC, monitor composite -> MC.
-- Any monitor from 3x3 up. Read the answers off the screen; no analysis
-- script is needed.
--
-- BOTTOM half of the monitor: tap right = next page, left = previous.
-- TOP half: tap = FIRE the page's test. Nothing risky runs until you fire,
-- so a page whose test kills the script can be stepped past.
-- number ch32 (dial) jumps straight to a page.
--
-- After FIRE the screen says "FIRING" for one frame, then makes the call:
--   "OK ..."  stays      -> no error; the text after OK is what came back
--   stuck on "FIRING", blank, or the MC shows a script error
--                        -> the call is an error. Respawn and go on.
-- "tick" lines are read in onTick, as a known-good value to compare with.
S=screen
P=1
N=7
q=false
-- stage of the test on this page: 0 idle, 1 announce, 2 make the call, 3 done
G=0
-- what came back, as text for the screen and as a number for output ch22
V=""
R=0
tn=0
tb=false
c=0
T={"control: nothing risky","input.getNumber(1) in onDraw","input.getBool(1) in onDraw",
"output.setNumber in onDraw","output.setBool in onDraw","screen.getWidth() in onTick",
"screen.drawRectF in onTick"}

function onTick()
  c=c+1
  tn=input.getNumber(1)
  tb=input.getBool(1)
  local h=input.getNumber(2)
  if tb and not q then
    if input.getNumber(4)<h/2 then
      if G==0 or G==3 then G=1 V="" R=0 end
    else
      P=(P-1+(input.getNumber(3)>tn/2 and 1 or -1))%N+1
      G=0 V="" R=0
    end
  end
  q=tb
  local n=input.getNumber(32)
  if n>=1 and math.floor(n)~=P then P=math.min(N,math.floor(n)) G=0 V="" R=0 end
  -- H6, H7: screen.* outside onDraw
  if G==2 and P==6 then R=S.getWidth() V="w="..R G=3 end
  if G==2 and P==7 then S.setColor(255,0,0) S.drawRectF(40,60,20,20) R=1 V="drew" G=3 end
  -- for a test harness (and anyone with a readout on the composite out)
  output.setNumber(20,P)
  output.setNumber(21,G)
  output.setNumber(22,R)
end

function L(i,s)
  S.drawText(2,3+i*7,s)
end

function onDraw()
  local W=S.getWidth()
  S.setColor(0,0,0)
  S.drawRectF(0,0,W,S.getHeight())
  S.setColor(0,160,0)
  L(0,"H"..P.." t"..c%100)
  S.setColor(255,255,255)
  S.drawTextBox(2,10,W-4,20,T[P],-1,-1)
  S.setColor(120,120,255)
  L(4,"tick n1="..tn)
  L(5,"tick b1="..tostring(tb))
  S.setColor(255,255,0)
  if G==0 then L(7,"TOP=FIRE") end
  if G==1 then L(7,"FIRING") G=2 return end
  if G==2 then
    if P==1 then R=1 V="ok" G=3 end
    if P==2 then R=input.getNumber(1) V="n1="..R G=3 end
    -- keep the finger down after FIRE: "t=" is the same moment read in onTick
    if P==3 then local b=input.getBool(1) R=b and 1 or 0 V="b="..tostring(b).." t="..tostring(tb) G=3 end
    if P==4 then output.setNumber(1,123) R=1 V="set 123" G=3 end
    if P==5 then output.setBool(1,true) R=1 V="set true" G=3 end
  end
  if G==3 then
    S.setColor(0,255,0)
    L(7,"OK "..V)
  end
end
