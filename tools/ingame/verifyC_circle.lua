-- PhySim 実機検証 C: drawCircle のアルゴリズム特定
-- 実機は r=1..7 が中点円と一致し、r=22 はどちらのモデルでも再現できなかった。
-- 半径を刻んで、一致しなくなる境目と大半径での規則を出す。
-- 接続と操作は A と同じ。右半分タップ=次 / 左半分=前。左上に "C<n>"。
-- 目盛は緑: 上端・下端・左端に 5px ごと 1px、10px ごと 2px。
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

-- 4象限に1つずつ。中心は (25,25) (70,25) (25,70) (70,70)。
-- r<=22 なら隣と重ならない。
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

  if P==1 then G(8,9,10,11)          -- 中点円と一致するか
  elseif P==2 then G(12,13,14,15)
  elseif P==3 then G(16,17,18,19)
  elseif P==4 then G(20,21,22,22)    -- 右下も r=22 (P5 の中心ずらしと比較する基準)
  elseif P==5 then
    -- 同じ r=22 で中心の小数部だけ変える
    S.drawCircle(25.25,25,22)
    S.drawCircle(70.5,25,22)
    S.drawCircle(25,70.5,22)
    S.drawCircle(70.75,70.75,22)
  elseif P==6 then
    -- 半径の小数部が形に効くか (A3 で r=2.6 と 2.7 が同形だった)
    G(15,15.25,15.5,15.75)
  elseif P==7 then S.drawCircle(48,48,32)   -- 大半径 1つだけ
  elseif P==8 then S.drawCircle(48,48,44)   -- 画面いっぱい
  else G(12,13,14,15,true)                  -- 塗りは輪郭と同じ規則か
  end
end
