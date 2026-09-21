-- PhySim 実機検証 A: 図形 (drawCircle / drawLine / drawTriangleF)
-- モニター(3x3 以上)を映像出力へ、そのコンポジット出力を MC 入力へ接続。
-- 画面の右半分タップ=次ページ / 左半分タップ=前ページ。左上に "A<n>" を表示。
-- 目盛は緑: 上端と左端に 5px ごと 1px、10px ごと 2px。
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
  -- 保険: number ch32 にダイヤルを繋げばページを直接指定できる
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
    -- 分割数・開始角・回転方向。半径によらず16角形か?
    S.drawCircle(48,52,22)

  elseif P==2 then
    -- 中心を半ピクセルずらすと P1 に対してどう動くか (round か floor か)
    S.drawCircle(48.5,52.5,22)

  elseif P==3 then
    -- 上段: 輪郭 r=1..7  中段: 塗り r=1..7
    -- 16角形なら辺長 = 0.39*r。1px 未満の辺が捨てられるなら r<=2.5 の輪郭は消える。
    local x=5
    for r=1,7 do
      S.drawCircle(x,20,r)
      S.drawCircleF(x,44,r)
      x=x+r*2+3
    end
    -- 下段: しきい値ちょうど (0.39*2.5=0.975 / 0.39*2.6=1.014)
    local t={2.4,2.5,2.6,2.7,3}
    for i=1,5 do S.drawCircle(i*14-4,70,t[i]) end

  elseif P==4 then
    -- 端点の小数をどう丸めるか。短い縦棒が整数基準、長い線が被検体。
    local f={0,.25,.5,.75,-.25}
    for i=1,5 do
      local b=i*16-8
      S.setColor(0,90,0) S.drawRectF(b,20,1,6)
      S.setColor(255,255,255) S.drawLine(b+f[i],30,b+f[i],56)
    end
    -- 同じことを Y 方向で。右の短い横棒が整数基準。
    for i=1,5 do
      local b=i*6+54
      S.setColor(0,90,0) S.drawRectF(70,b,6,1)
      S.setColor(255,255,255) S.drawLine(20,b+f[i],60,b+f[i])
    end

  elseif P==5 then
    -- 左: 水平線の長さ 0..2px。どこから描かれ、何画素になるか。
    local L={0,.3,.5,.7,.9,1,1.1,1.5,2}
    for i=1,9 do
      local y=i*6+10
      S.setColor(0,90,0) S.drawRectF(6,y,1,1)
      S.setColor(255,255,255) S.drawLine(12,y,12+L[i],y)
    end
    -- 右: 斜め。長さ判定が dx^2+dy^2 か軸ごとかを分ける
    -- (.8,.8) は斜長 1.13 だが軸長 0.8。
    local d={{.8,.8},{.6,.6},{.9,.4},{1.2,0},{.7,.7}}
    for i=1,5 do
      local y=i*8+16
      S.setColor(0,90,0) S.drawRectF(56,y,1,1)
      S.setColor(255,255,255) S.drawLine(62,y,62+d[i][1],y+d[i][2])
    end

  else
    -- 塗り三角形の境界規則 (中心が内側の画素だけか、はみ出すか)
    S.drawTriangleF(6.5,12.25,46.75,26.5,18,60.125)
    S.drawTriangle(52,12,92,26,64,60)
    -- 同じ直角三角形を 整数 と +0.5 で。各行の幅を比べる。
    S.drawTriangleF(50,68,70,68,50,88)
    S.drawTriangleF(10.5,68.5,30.5,68.5,10.5,88.5)
  end
end
