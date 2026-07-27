// =============================================================
// ダッシュボードのチャート群 (recharts 依存) を App.jsx から切り出した
// 遅延ロード用モジュール。App.jsx が React.lazy(() => import(...)) で読み込むことで、
// recharts をメインチャンクから分離し、チャート表示時に初めて取得させる
// (初回ログイン時のバンドル削減目的)。ロジックは App.jsx から無改変で移設。
// =============================================================
import {
  PieChart, Pie, Cell, AreaChart, Area,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from "recharts";
import { GOLD, NAVY2, TEXT_PRIMARY, TEXT_MUTED } from "@shared/theme";

// カテゴリー別支出の円グラフ。
//   props.catBreakdown   : [{ name, value, color }]
//   props.catLabelLayout : 小スライスの引き出しラベル押し下げ事前計算 (App.jsx L732)
export function CategoryPieChart({ catBreakdown, catLabelLayout }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie
          data={catBreakdown} cx="50%" cy="50%" innerRadius={50} outerRadius={90} dataKey="value" labelLine={false}
          label={({cx,cy,midAngle,innerRadius,outerRadius,name,percent,fill,index})=>{
            const RADIAN=Math.PI/180;
            const pctInt=Math.round(percent*100);
            // 中サイズ以上: リング内側に従来どおり重ね描画 (補正対象外)
            if(percent>=0.08){
              const r=innerRadius+(outerRadius-innerRadius)*0.5;
              const x=cx+r*Math.cos(-midAngle*RADIAN);
              const yy=cy+r*Math.sin(-midAngle*RADIAN);
              return(
                <g>
                  <text x={x} y={yy-7} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700}>{name.length>4?name.slice(0,4):name}</text>
                  <text x={x} y={yy+9} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700}>{pctInt}%</text>
                </g>
              );
            }
            // 小サイズ: スライス外縁からリーダーライン → 外側ラベル。
            // タスクB (2026-06-07): catLabelLayout から事前計算済の finalYOffset / side を取得し、
            //   小スライス同士の y 衝突を minGap=18px で押し下げて回避する。引き出し線は
            //   sx,sy (スライス外周) → bx,finalY (押し下げ後の屈曲点) → ex,finalY (水平延長) の
            //   2 線分で構成。屈曲点 x は元の (outerRadius+8)*cos に合わせ、押し下げで生じた
            //   オフセットは最初の線分の斜めで吸収。textAnchor は side で振り分け。
            const cos=Math.cos(-midAngle*RADIAN);
            const sin=Math.sin(-midAngle*RADIAN);
            const sx=cx+outerRadius*cos;
            const sy=cy+outerRadius*sin;
            const layout=catLabelLayout?.[index];
            const side=layout?layout.side:(cos>=0?'right':'left');
            const finalY=layout?(cy+layout.finalYOffset):(cy+(outerRadius+8)*sin);
            const dirSign=side==='right'?1:-1;
            const bx=cx+(outerRadius+8)*cos;   // 屈曲点 x (元の natural x、押し下げで y のみ動く)
            const ex=bx+dirSign*10;             // ラベルアンカー x (さらに水平に 10px 延長)
            const ey=finalY;
            const textAnchor=side==='right'?'start':'end';
            const tx=ex+dirSign*3;
            const lineColor=fill||TEXT_MUTED;
            return(
              <g>
                <path d={`M${sx},${sy}L${bx},${finalY}L${ex},${ey}`} stroke={lineColor} strokeWidth={1} fill="none" opacity={0.7}/>
                <circle cx={ex} cy={ey} r={1.5} fill={lineColor}/>
                <text x={tx} y={ey} fill={TEXT_PRIMARY} textAnchor={textAnchor} dominantBaseline="central" fontSize={10} fontWeight={600}>{(name.length>4?name.slice(0,4):name)} {pctInt}%</text>
              </g>
            );
          }}
        >
          {catBreakdown.map((e,i)=><Cell key={i} fill={e.color}/>)}
        </Pie>
        <Tooltip formatter={v=>`${v.toLocaleString()}円`}/>
      </PieChart>
    </ResponsiveContainer>
  );
}

// 月別支出の推移エリアチャート。
//   props.yearlyData : [{ name, month, year, expense }]
//   props.today      : 現在日 (当月ドットの強調判定に使用)
export function YearlyAreaChart({ yearlyData, today }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={yearlyData} margin={{top:16,right:8,left:8,bottom:0}}>
        <defs>
          <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={GOLD} stopOpacity={0.45}/>
            <stop offset="100%" stopColor={GOLD} stopOpacity={0.02}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false}/>
        {/* 基準ライン */}
        <ReferenceLine y={500000} stroke="rgba(46,216,180,0.35)" strokeDasharray="4 3"
          label={{value:"50万",position:"insideTopRight",fontSize:9,fill:"rgba(46,216,180,0.7)",fontWeight:700}}/>
        <ReferenceLine y={1000000} stroke="rgba(255,71,87,0.35)" strokeDasharray="4 3"
          label={{value:"100万",position:"insideTopRight",fontSize:9,fill:"rgba(255,71,87,0.7)",fontWeight:700}}/>
        <XAxis
          dataKey="name"
          tick={{fontSize:10,fill:"rgba(240,234,214,0.4)"}}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{fontSize:9,fill:"rgba(240,234,214,0.3)"}}
          axisLine={false}
          tickLine={false}
          tickFormatter={v=>v===0?"":v>=10000?`${Math.round(v/10000)}万`:`${v}`}
          width={34}
        />
        <Tooltip
          formatter={v=>[`${v.toLocaleString()}円`,"支出"]}
          contentStyle={{background:NAVY2,border:`1px solid ${GOLD}44`,borderRadius:10,fontSize:12,color:TEXT_PRIMARY}}
          labelStyle={{color:GOLD,fontWeight:700,marginBottom:4}}
          cursor={{stroke:`${GOLD}33`,strokeWidth:1}}
        />
        <Area
          type="linear"
          dataKey="expense"
          stroke={GOLD}
          strokeWidth={2.5}
          fill="url(#goldGrad)"
          dot={(props)=>{
            const {cx,cy,payload,index}=props;
            const isCurrentMonth = payload.month===(today.getMonth()+1)&&payload.year===today.getFullYear();
            const hasData = payload.expense > 0;
            if(!hasData) return <circle key={index} cx={cx} cy={cy} r={2} fill="rgba(212,168,67,0.2)" stroke="none"/>;
            return(
              <g key={index}>
                <circle cx={cx} cy={cy}
                  r={isCurrentMonth?7:4}
                  fill={isCurrentMonth?GOLD:NAVY2}
                  stroke={GOLD}
                  strokeWidth={2}
                />
                {/* 金額ラベル */}
                <text x={cx} y={cy-12} textAnchor="middle" fontSize={8} fill={isCurrentMonth?GOLD:"rgba(212,168,67,0.7)"} fontWeight={700}>
                  {payload.expense>=1000000
                    ? `${(payload.expense/10000).toFixed(0)}万`
                    : payload.expense>=10000
                    ? `${Math.round(payload.expense/10000)}万`
                    : `${payload.expense.toLocaleString()}`
                  }
                </text>
              </g>
            );
          }}
          activeDot={{r:8,fill:GOLD,stroke:NAVY2,strokeWidth:2}}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
