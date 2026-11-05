#target illustrator
/*
 CAD Light Cleaner v1.3 — Illustrator 2026 / Windows / ExtendScript ES3.
 Faster bounded scans; independent controller heartbeat and nonblocking completion.
 Original .ai is never saved/overwritten automatically. Work on a manually saved copy.
 JSX runs synchronously inside Illustrator: native duplicate/setEntirePath/remove calls
 cannot be interrupted until Adobe returns. No zero-hang or other-document-edit guarantee.
 Stop preserves completed operations; incomplete replacement copies are discarded.
 Geometry-changing joins and curve approximation are opt-in. No app.redraw during edits.
 External controller only exchanges commands/status files and never invokes Illustrator COM.
*/
(function () {
    if (app.documents.length < 1) { alert('문서가 열려 있지 않습니다.'); return; }
    var doc = app.activeDocument;
    var VERSION = '1.3';
    var LIMIT_PATHS = 20000, LIMIT_POINTS = 120000, LIMIT_OUTPUT = 4000;
    var MAX_CHAIN_SOURCES = 64, MAX_SCAN_ITEMS = 100000, WORK_BUDGET_MS = 45000;
    var UI_BATCH = 64, COMMIT_BATCH = 4, EPS = 0.00001;
    var EXACT_SQ = 1e-10, SAME_SQ = 1e-12, ZERO_SQ = 1e-12;
    var MAX_PREVIEW_POINTS = 120, MAX_APPROX_POINTS = 180, MAX_APPROX_TESTS = 400, MAX_APPROX_PATHS = 30;
    var prepared = null, quitting = false, paused = false;
    var control = null, lastUiMs = 0, lastPollMs = 0, currentStep = '', operationsDone = 0;
    var sessionLog = [];
    var workStartMs=0, pausedWorkMs=0, stopReason='', lastYieldMs=0, rollbackErrors=0;
    function currentMillis() { return (new Date()).getTime(); }
    function writeUTF8(f, data) {
        try {
            f.encoding='UTF-8';
            if(!f.open('w')) return false;
            f.write(String(data));f.close();return true;
        } catch(e) {try{f.close();}catch(ignore){} return false;}
    }
    function readTextFile(f) {
        try {if(!f || !f.exists) return null;f.encoding='UTF-8';if(!f.open('r'))return null;var txt=f.read();f.close();return String(txt);}
        catch(e){try{f.close();}catch(ignore){} return null;}
    }
    function safeName(t) {return String(t).replace(/[|\r\n]/g,' ').substring(0,180);}
    function escapeVBS(t) {return String(t).replace(/"/g,'""');}
    function makeControlScript() {
        var lines=[
            "param([string]$cmdPath,[string]$statusPath,[string]$readyPath,[string]$donePath,[string]$closedPath,[string]$heartbeatPath,[string]$errorPath)",
            "$ErrorActionPreference = \"Stop\"",
            "try {",
            "  Add-Type -AssemblyName System.Windows.Forms",
            "  Add-Type -AssemblyName System.Drawing",
            "  [System.Windows.Forms.Application]::EnableVisualStyles()",
            "  $form = New-Object System.Windows.Forms.Form",
            "  $form.Text = \"CAD Light Cleaner v1.3 | 독립 작업 제어\"",
            "  $form.StartPosition = \"CenterScreen\"",
            "  $form.ClientSize = New-Object System.Drawing.Size(480,188)",
            "  $form.FormBorderStyle = \"FixedDialog\"",
            "  $form.MaximizeBox = $false",
            "  $form.TopMost = $true",
            "  $font = New-Object System.Drawing.Font(\"Malgun Gothic\",9)",
            "  $form.Font = $font",
            "  $lbl = New-Object System.Windows.Forms.Label",
            "  $lbl.Location = New-Object System.Drawing.Point(14,12)",
            "  $lbl.Size = New-Object System.Drawing.Size(452,42)",
            "  $lbl.Text = \"초기화 중...\"",
            "  $form.Controls.Add($lbl)",
            "  $bar = New-Object System.Windows.Forms.ProgressBar",
            "  $bar.Location = New-Object System.Drawing.Point(14,58)",
            "  $bar.Size = New-Object System.Drawing.Size(452,18)",
            "  $bar.Minimum=0; $bar.Maximum=100",
            "  $form.Controls.Add($bar)",
            "  $stats = New-Object System.Windows.Forms.Label",
            "  $stats.Location = New-Object System.Drawing.Point(14,83)",
            "  $stats.Size = New-Object System.Drawing.Size(452,25)",
            "  $stats.Text = \"완료된 작업: 0 | X를 누르면 중단 요청 후 창 닫기\"",
            "  $form.Controls.Add($stats)",
            "  $pause = New-Object System.Windows.Forms.Button",
            "  $pause.Location = New-Object System.Drawing.Point(14,118)",
            "  $pause.Size = New-Object System.Drawing.Size(205,42)",
            "  $pause.Text = \"Ⅱ 일시정지\"",
            "  $form.Controls.Add($pause)",
            "  $stop = New-Object System.Windows.Forms.Button",
            "  $stop.Location = New-Object System.Drawing.Point(228,118)",
            "  $stop.Size = New-Object System.Drawing.Size(238,42)",
            "  $stop.Text = \"■ 안전 중단 · 완료 결과 유지\"",
            "  $form.Controls.Add($stop)",
            "  $script:stopped=$false; $script:paused=$false; $script:finished=$false",
            "  $script:finishTicks=0; $script:heartbeat=0; $script:ticks=0",
            "  function Set-Cmd([string]$value) {",
            "    try {[System.IO.File]::WriteAllText($cmdPath,$value,[System.Text.Encoding]::ASCII)} catch {}",
            "  }",
            "  $pause.Add_Click({",
            "    if($script:stopped -or $script:finished){return}",
            "    if($script:paused){$script:paused=$false;Set-Cmd \"RUN\";$pause.Text=\"Ⅱ 일시정지\"}",
            "    else {$script:paused=$true;Set-Cmd \"PAUSE\";$pause.Text=\"▶ 재개\"}",
            "  })",
            "  $stop.Add_Click({",
            "    $script:stopped=$true;$script:paused=$false;Set-Cmd \"STOP\"",
            "    $stop.Enabled=$false;$pause.Enabled=$false",
            "    $lbl.Text=\"중단 요청 완료 · 현재 단위 작업의 안전 종료 대기 중...\"",
            "  })",
            "  # Never trap the user in this window if Illustrator or IPC has failed.",
            "  $form.Add_FormClosing({if(-not $script:finished){Set-Cmd \"STOP\"}})",
            "  $form.Add_FormClosed({try{[System.IO.File]::WriteAllText($closedPath,\"CLOSED\")}catch{}})",
            "  $timer = New-Object System.Windows.Forms.Timer",
            "  $timer.Interval=160",
            "  function Finish-Control {",
            "    if(-not $script:finished){",
            "      $script:finished=$true;$pause.Enabled=$false;$stop.Enabled=$false",
            "      $form.Text=\"CAD Light Cleaner v1.3 | 단계 종료\"",
            "      $lbl.Text=\"단계 종료 · 이 창은 자동으로 닫힙니다. Illustrator의 결과를 확인하세요.\"",
            "    }",
            "  }",
            "  $timer.Add_Tick({",
            "    # Completion detection is independent of heartbeat/status read failures.",
            "    try {if([System.IO.File]::Exists($donePath)){Finish-Control}}catch{}",
            "    if($script:finished){",
            "      $script:finishTicks++",
            "      if($script:finishTicks -ge 4){$timer.Stop();$form.Close()}",
            "      return",
            "    }",
            "    try {",
            "      $script:ticks++",
            "      if(($script:ticks % 5) -eq 0){",
            "        $script:heartbeat++",
            "        [System.IO.File]::WriteAllText($heartbeatPath,[string]$script:heartbeat,[System.Text.Encoding]::ASCII)",
            "      }",
            "    }catch{}",
            "    $raw=\"\"",
            "    try {if([System.IO.File]::Exists($statusPath)){$raw=[System.IO.File]::ReadAllText($statusPath,[System.Text.Encoding]::UTF8)}}catch{}",
            "    if($raw.StartsWith(\"FINAL|\")){Finish-Control;return}",
            "    try {",
            "      $bits=$raw.Split([char]\"|\")",
            "      if($bits.Length -ge 3){",
            "        $pct=0;[void][int]::TryParse($bits[0],[ref]$pct)",
            "        $bar.Value=[Math]::Min(100,[Math]::Max(0,$pct))",
            "        if(-not $script:stopped){$lbl.Text=$bits[2]}",
            "        $stats.Text=\"완료 처리 \"+$bits[1]+\"건\"+$(if($script:paused){\" · 일시정지 중\"}else{\"\"})",
            "      }",
            "    } catch {}",
            "  })",
            "  $form.Add_Shown({",
            "    [System.IO.File]::WriteAllText($heartbeatPath,\"0\",[System.Text.Encoding]::ASCII)",
            "    [System.IO.File]::WriteAllText($readyPath,\"READY\",[System.Text.Encoding]::ASCII)",
            "    $timer.Start()",
            "  })",
            "  [void]$form.ShowDialog()",
            "} catch {",
            "  try{[System.IO.File]::WriteAllText($errorPath,$_.Exception.Message,[System.Text.Encoding]::UTF8)}catch{}",
            "} finally {",
            "  try{if($timer){$timer.Stop();$timer.Dispose()}}catch{}",
            "  try{if($form){$form.Dispose()}}catch{}",
            "  try{if($font){$font.Dispose()}}catch{}",
            "  try{[System.IO.File]::WriteAllText($closedPath,\"CLOSED\")}catch{}",
            "}"
        ];
        return lines.join('\r\n');
    }
    function n(v) { return Number(v); }
    function p2(a) { return [n(a[0]), n(a[1])]; }
    function d2(a, b) { var x=a[0]-b[0],y=a[1]-b[1]; return x*x+y*y; }
    function finite(p) { return p && isFinite(p[0]) && isFinite(p[1]); }
    function vec(a,b) { return [b[0]-a[0], b[1]-a[1]]; }
    function norm(a) { var v=Math.sqrt(a[0]*a[0]+a[1]*a[1]); return v>1e-12?[a[0]/v,a[1]/v]:null; }
    function clamp(x,a,b) { return Math.max(a,Math.min(b,x)); }
    function quant(x) { return String(Math.round(x*1000000)); }
    function same(a,b) { return d2(a,b)<=SAME_SQ; }
    function clonePt(p) { return {a:p2(p.a),l:p2(p.l),r:p2(p.r),t:p.t}; }
    function clonePts(ps) { var a=[]; for(var i=0;i<ps.length;i++) a.push(clonePt(ps[i])); return a; }
    function reversePts(ps) { var z=[]; for(var i=ps.length-1;i>=0;i--) z.push({a:p2(ps[i].a),l:p2(ps[i].r),r:p2(ps[i].l),t:ps[i].t}); return z; }
    function isPlain(item) {
        try {
            if (item.typename!=='PathItem' || item.guides || item.clipping || !item.stroked || item.filled) return false;
            var col=item.strokeColor, typ=String(col.typename);
            if (typ!=='RGBColor' && typ!=='CMYKColor' && typ!=='GrayColor' && typ!=='SpotColor') return false;
            var cur=item, safety=0;
            while(cur && safety++<80) {
                if(cur.typename==='CompoundPathItem' || (cur.typename==='GroupItem' && cur.clipped) || cur.locked || cur.hidden) return false;
                if(cur.typename==='Layer' && !cur.visible) return false;
                if(cur.typename==='Document') return true;
                cur=cur.parent;
            }
            return false;
        } catch(e) {return false;}
    }
    function colorKey(c) {
        try {
            var t=c.typename;
            if(t==='RGBColor') return 'rgb/'+quant(c.red)+','+quant(c.green)+','+quant(c.blue);
            if(t==='CMYKColor') return 'cmyk/'+quant(c.cyan)+','+quant(c.magenta)+','+quant(c.yellow)+','+quant(c.black);
            if(t==='GrayColor') return 'gray/'+quant(c.gray);
            if(t==='SpotColor') return 'spot/'+String(c.spot.name)+'/'+quant(c.tint);
        } catch(e) {} return null;
    }
    function styleKey(it) {
        try {
            var c=colorKey(it.strokeColor); if(!c)return null;
            var dash=it.strokeDashes||[], ds=[];
            for(var i=0;i<dash.length;i++)ds.push(quant(Number(dash[i])));
            return c+'|'+quant(it.strokeWidth)+'|'+it.strokeCap+'|'+it.strokeJoin+'|'+
                quant(it.strokeMiterLimit)+'|'+quant(it.strokeDashOffset)+'|'+ds.join(',')+'|'+
                quant(it.opacity)+'|'+it.blendingMode+'|'+String(it.strokeOverprint);
        }catch(e) {return null;}
    }
    function readPts(it) {
        var out=[], ps=it.pathPoints, k;
        for(k=0;k<ps.length;k++) {
            if((k & 255)===0) {
                tick('큰 패스 읽기: '+k+' / '+ps.length,15,false);
                if(quitting)return null;
            }
            var q=ps[k], a=p2(q.anchor), l=p2(q.leftDirection), r=p2(q.rightDirection);
            if(!finite(a)||!finite(l)||!finite(r)) return null;
            out.push({a:a,l:l,r:r,t:q.pointType});
        }
        return out;
    }
    function straight(a,b) { return d2(a,b)<=SAME_SQ; }
    function allZero(pts) {
        if(!pts.length)return true;
        var base=pts[0].a;
        for(var i=0;i<pts.length;i++) if(d2(base,pts[i].a)>ZERO_SQ || d2(base,pts[i].l)>ZERO_SQ || d2(base,pts[i].r)>ZERO_SQ) return false;
        return true;
    }
    function redundant(p0,p1,p2) {
        if(!straight(p0.a,p0.r)||!straight(p1.a,p1.l)||!straight(p1.a,p1.r)||!straight(p2.a,p2.l)) return false;
        var ab=vec(p0.a,p1.a), ac=vec(p0.a,p2.a), mag=ac[0]*ac[0]+ac[1]*ac[1];
        if(mag<=ZERO_SQ)return false;
        var t=(ab[0]*ac[0]+ab[1]*ac[1])/mag;
        if(t<=0||t>=1)return false;
        var e=[p0.a[0]+t*ac[0],p0.a[1]+t*ac[1]];
        return d2(p1.a,e)<=EXACT_SQ;
    }
    function reduceStraight(pts, closed) {
        // Linear-time stack: handles long CAD polylines without quadratic splice scans.
        if(closed||pts.length<3)return {p:pts,deleted:0};
        var result=[], changed=0;
        for(var i=0;i<pts.length;i++) {
            if((i & 255)===0) {
                tick('직선 앵커 분석 '+i+' / '+pts.length,40,false);
                if(quitting)return {p:pts,deleted:0};
            }
            result.push(clonePt(pts[i]));
            while(result.length>=3) {
                var t=result.length-1;
                if(!redundant(result[t-2],result[t-1],result[t]))break;
                result.splice(t-1,1);changed++;
            }
        }
        return {p:result,deleted:changed};
    }
    function cubic(a,b,t) {
        var u=1-t, x=u*u*u*a.a[0]+3*u*u*t*a.r[0]+3*u*t*t*b.l[0]+t*t*t*b.a[0];
        var y=u*u*u*a.a[1]+3*u*u*t*a.r[1]+3*u*t*t*b.l[1]+t*t*t*b.a[1];
        return [x,y];
    }
    function sampledSegment(a,b,steps) { var q=[]; for(var i=0;i<=steps;i++)q.push(cubic(a,b,i/steps)); return q; }
    function samplePair(a,b,c,steps) {
        var left=sampledSegment(a,b,steps),right=sampledSegment(b,c,steps);
        for(var i=1;i<right.length;i++) left.push(right[i]);
        return left;
    }
    function polyAt(poly,f) {
        var lengths=[0],total=0,i;
        for(i=1;i<poly.length;i++){total+=Math.sqrt(d2(poly[i],poly[i-1]));lengths.push(total);}
        if(total<1e-10)return p2(poly[0]);
        var target=total*f;
        for(i=1;i<poly.length;i++)if(lengths[i]>=target){
            var den=lengths[i]-lengths[i-1], k=den>0?(target-lengths[i-1])/den:0;
            return [poly[i-1][0]+k*(poly[i][0]-poly[i-1][0]),poly[i-1][1]+k*(poly[i][1]-poly[i-1][1])];
        }
        return p2(poly[poly.length-1]);
    }
    function ptSegDist2(p,a,b) {
        var dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
        if(d<1e-20)return d2(p,a);
        var t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d,0,1);
        return d2(p,[a[0]+t*dx,a[1]+t*dy]);
    }
    function polyErrOneWay(A,B) {
        var max=0;
        for(var i=0;i<A.length;i++) {
            if((i & 7)===0){tick('곡선 형상 비교',44,false);if(quitting)return 1e100;}
            var best=1e100;
            for(var j=1;j<B.length;j++) {var e=ptSegDist2(A[i],B[j-1],B[j]);if(e<best)best=e;}
            if(best>max)max=best;
        }
        return max;
    }
    function fitPair(a,b,c,tol) {
        var vin=norm(vec(b.l,b.a)),vout=norm(vec(b.a,b.r));
        if(!vin||!vout||(vin[0]*vout[0]+vin[1]*vout[1])<0.997)return null;
        var u=norm(vec(a.a,a.r)),w=norm(vec(c.a,c.l));
        if(!u||!w)return null;
        var chord=Math.sqrt(d2(a.a,c.a)),best=null;
        // A removed middle anchor may lie at an arbitrary parameter position on
        // the original cubic. Fit several split positions instead of assuming
        // that cubic parameter t is proportional to arc length.
        var splitRatios=[0.2,0.3,0.4,0.5,0.6,0.7,0.8];
        for(var h=0;h<splitRatios.length;h++) {
            tick('곡선 오차 검증',44,false);if(quitting)return null;
            var split=splitRatios[h],s11=0,s12=0,s22=0,r1=0,r2=0;
            for(var z=1;z<24;z++) {
                var t=z/24,one=1-t,aa=3*one*one*t,bb=3*one*t*t;
                var v=t<=split?cubic(a,b,t/split):cubic(b,c,(t-split)/(1-split));
                var base=[Math.pow(one,3)*a.a[0]+aa*a.a[0]+bb*c.a[0]+t*t*t*c.a[0],
                          Math.pow(one,3)*a.a[1]+aa*a.a[1]+bb*c.a[1]+t*t*t*c.a[1]];
                var x1=aa*u[0],y1=aa*u[1],x2=bb*w[0],y2=bb*w[1];
                s11+=x1*x1+y1*y1;s12+=x1*x2+y1*y2;s22+=x2*x2+y2*y2;
                r1+=x1*(v[0]-base[0])+y1*(v[1]-base[1]);
                r2+=x2*(v[0]-base[0])+y2*(v[1]-base[1]);
            }
            var det=s11*s22-s12*s12;if(det<1e-14)continue;
            var k1=(r1*s22-r2*s12)/det,k2=(s11*r2-s12*r1)/det;
            if(k1<0||k2<0||k1>Math.max(0.001,3*chord)||k2>Math.max(0.001,3*chord))continue;
            var start=clonePt(a),end=clonePt(c);
            start.r=[a.a[0]+u[0]*k1,a.a[1]+u[1]*k1];
            end.l=[c.a[0]+w[0]*k2,c.a[1]+w[1]*k2];
            var errorSq=0;
            for(var zz=1;zz<24;zz++) {
                var tt=zz/24;
                var original=tt<=split?cubic(a,b,tt/split):cubic(b,c,(tt-split)/(1-split));
                var fitted=cubic(start,end,tt);
                errorSq+=d2(original,fitted);
            }
            if(!best||errorSq<best.score)best={a:start,b:end,score:errorSq};
        }
        if(!best||best.score>23*tol*tol) return null;
        // Two-way sampled geometric discrepancy, conservatively below tolerance.
        var orig=samplePair(a,b,c,48),cand=sampledSegment(best.a,best.b,96);
        var err=Math.max(polyErrOneWay(orig,cand),polyErrOneWay(cand,orig));
        if(err>0.64*tol*tol)return null;
        best.error=Math.sqrt(err);
        return best;
    }
    function approximateCurves(pts,closed,tol) {
        if(closed||pts.length>MAX_APPROX_POINTS||pts.length<3)return {p:pts,removed:0,err:0};
        var out=clonePts(pts),count=0,maxErr=0,budget=0,tries=0;
        var i=1;
        while(i<out.length-1 && tries++<MAX_APPROX_TESTS) {
            if((tries & 15)===0) {tick('곡선 근사 검사 '+tries+'회',44,false);if(quitting)break;}
            var fit=fitPair(out[i-1],out[i],out[i+1],tol);
            if(fit && budget+fit.error <= 0.8*tol) {out[i-1]=fit.a;out[i+1]=fit.b;out.splice(i,1);count++;budget+=fit.error;maxErr=budget;if(i>1)i--;}
            else i++;
        }
        return {p:out,removed:count,err:maxErr};
    }
    function isEditableGroup(g) {
        try {
            if(g.typename!=='GroupItem'||g.locked||g.hidden||g.clipped||g.pageItems.length!==0)return false;
            var p=g.parent;while(p && p.typename!=='Document'){if(p.hidden||p.locked)return false;if(p.typename==='Layer'&&!p.visible)return false;p=p.parent;}
            return true;
        }catch(e){return false;}
    }
    function noopStats() {return {pathsRead:0,pointsRead:0,skipped:0,limit:false,zero:0,dups:0,linePoints:0,curvePoints:0,joints:0,chains:0,emptyGroups:0,cross:0,ambiguous:0,approxPaths:0};}
    function sourceItems(selectionOnly) {
        var out=[], seen=[], seenIDs={};
        var traversed=0,scanned=0;
        function pushUnique(it) {
            if((++traversed & 63)===0){tick('선택된 개체 탐색 '+traversed+'개',2,false);if(quitting)return;}
            // Illustrator 2026 page items normally expose a stable UUID.
            // Fallback reference comparison for items without UUID.
            try { var uid=it.uuid; if(uid){var key="u:"+String(uid);if(seenIDs[key])return;seenIDs[key]=true;out.push(it);return;} }catch(e){}
            for(var j=0;j<seen.length;j++)if(seen[j]===it)return;
            seen.push(it);out.push(it);
        }
        function recurse(it,depth) {
            if(!it||depth>25||quitting)return;
            if(++scanned>MAX_SCAN_ITEMS){quitting=true;stopReason='선택 탐색 한도입니다. 범위를 나눠 실행하세요.';return;}
            if((scanned & 63)===0)tick('선택 개체 탐색 '+scanned+'개',2,false);
            if(quitting)return;
            var typ=it.typename;
            if(typ==='PathItem')pushUnique(it);
            else if(typ==='GroupItem') {
                var children=it.pageItems;
                for(var j=0;j<children.length;j++){if(quitting)break;recurse(children[j],depth+1);}
            }
        }
        if(selectionOnly) {
            var sel=doc.selection||[];
            for(var k=0;k<sel.length;k++){if(quitting)break;recurse(sel[k],0);}
        } else {
            // Document.pathItems is a flat collection, minimizing large-document recursion.
            var ps=doc.pathItems;
            for(var i=0;i<ps.length;i++){
                if((i & 127)===0){tick('전체 문서 개체 탐색 '+(i+1)+' / '+ps.length,2,false);if(quitting)break;}
                out.push(ps[i]);
            }
        }
        return out;
    }
    function requestState() {
        if(!control || quitting)return;
        if(control.closed && control.closed.exists){
            quitting=true;paused=false;stopReason='제어창이 닫혀 안전 중단했습니다.';return;
        }
        if(control.heartbeat){
            var alive=readTextFile(control.heartbeat), now=currentMillis();
            if(alive!==null && alive!==control.lastHeartbeat){control.lastHeartbeat=alive;control.lastHeartbeatMs=now;}
            if(now-control.lastHeartbeatMs>8000){
                quitting=true;paused=false;stopReason='제어창 응답이 끊겨 안전 중단했습니다.';return;
            }
        }
        var txt=readTextFile(control.command);
        if(txt===null)return;
        txt=String(txt).replace(/\s/g,'').toUpperCase();
        if(txt==='STOP'){quitting=true;paused=false;stopReason='사용자가 중단을 요청했습니다.';}
        else if(txt==='PAUSE'&&!quitting)paused=true;
        else if(txt==='RUN')paused=false;
    }
    function publishStatus(label,pct,force) {
        if(!control)return;
        var now=currentMillis();if(!force&&now-lastUiMs<150)return;
        lastUiMs=now;currentStep=label;
        var phrase=quitting?'중단 요청 접수 · 완료 단계 유지':(paused?'일시정지 중 · 재개 또는 중단을 누르세요':label);
        writeUTF8(control.status, String(Math.floor(clamp(pct,0,100)))+'|'+operationsDone+'|'+safeName(phrase));
    }
    function tick(label,pct,force) {
        if(!control || quitting)return;
        var now=currentMillis();
        // Legacy force calls may not bypass file IO throttles.
        if(now-lastPollMs>=75){lastPollMs=now;requestState();}
        publishStatus(label,pct,false);
        var waitStart=currentMillis();
        while(paused&&!quitting){
            $.sleep(100);requestState();publishStatus(label,pct,false);
        }
        pausedWorkMs+=currentMillis()-waitStart;
        now=currentMillis();
        if(workStartMs && now-workStartMs-pausedWorkMs>WORK_BUDGET_MS && !quitting){
            quitting=true;stopReason='단계별 45초 작업 한도에 도달했습니다. 선택 범위를 나눠 실행하세요.';
        }
        if(now-lastYieldMs>=100){lastYieldMs=now;$.sleep(1);}
    }
    function startProgress(title) {
        quitting=false;paused=false;lastUiMs=0;lastPollMs=0;operationsDone=0;
        stopReason='';rollbackErrors=0;pausedWorkMs=0;workStartMs=0;lastYieldMs=0;sessionLog=[];
        control=null;
        try {
            if(String($.os).toLowerCase().indexOf('windows')<0)throw Error('Windows 전용 독립 제어창입니다.');
            var token=String(currentMillis())+'_'+String(Math.floor(Math.random()*1000000));
            var dir=new Folder(Folder.temp.fsName+'/CAD_LightCleaner_13_'+token);
            if(!dir.create())throw Error('임시 제어 폴더 생성 실패');
            var file=function(name){return new File(dir.fsName+'/'+name);};
            control={dir:dir,command:file('command.txt'),status:file('status.txt'),ready:file('ready.flag'),
                done:file('done.flag'),closed:file('closed.flag'),heartbeat:file('heartbeat.txt'),error:file('error.txt'),
                lastHeartbeat:'',lastHeartbeatMs:currentMillis(),files:[],launched:false};
            var ps=file('control.ps1'),vbs=file('launch.vbs');
            control.files=[ps,vbs,control.command,control.status,control.ready,control.done,control.closed,control.heartbeat,control.error];
            if(!writeUTF8(ps,'\uFEFF'+makeControlScript()) || !writeUTF8(control.command,'RUN') ||
                !writeUTF8(control.status,'0|0|초기화 중...'))throw Error('제어 파일 생성 실패');
            var launchCmd='powershell.exe -NoProfile -NoLogo -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+ps.fsName+'"';
            var args=[control.command,control.status,control.ready,control.done,control.closed,control.heartbeat,control.error];
            for(var a=0;a<args.length;a++)launchCmd+=' "'+args[a].fsName+'"';
            vbs.encoding='UTF-16';
            if(!vbs.open('w'))throw Error('컨트롤러 실행기 생성 실패');
            vbs.write('CreateObject("WScript.Shell").Run "'+escapeVBS(launchCmd)+'", 0, False\r\n');vbs.close();
            if(!vbs.execute())throw Error('Windows 제어창 시작 실패');
            control.launched=true;
            var t0=currentMillis();
            while(!control.ready.exists && currentMillis()-t0<6000){
                if(control.error.exists)throw Error(readTextFile(control.error));
                if(control.closed.exists)throw Error('제어창이 준비 전에 종료되었습니다.');
                $.sleep(80);
            }
            if(!control.ready.exists)throw Error('독립 제어창을 확인하지 못했습니다. PowerShell/보안 정책을 확인하세요.');
            control.lastHeartbeatMs=currentMillis();workStartMs=currentMillis();
            publishStatus(title,0,true);
        }catch(e){
            quitting=true;paused=false;stopReason=String(e);endProgress('error','작업 시작 취소');
            alert('작업 시작 취소: 외부 중단 제어창을 확인할 수 없습니다. 원본 변경 없음.\n\n'+e);
        }
    }
    function endProgress(outcome,label) {
        var owned=control;
        if(!owned){paused=false;return;}
        try {
            var terminal='FINAL|'+(outcome|| (quitting?'stopped':'done'))+'|'+operationsDone+'|'+safeName(label||'단계 종료');
            // Never read commands, enter PAUSE, or call tick while finalizing.
            var statusOK=writeUTF8(owned.status,terminal),doneOK=false;
            for(var a=0;a<3 && !doneOK;a++){
                doneOK=writeUTF8(owned.done,terminal);
                if(!doneOK)$.sleep(40);
            }
            if(!doneOK && !statusOK)sessionLog.push('종료 신호 전송 실패: 외부 창의 X로 닫으세요.');
            var t0=currentMillis();
            while(owned.launched!==false && owned.closed && !owned.closed.exists && currentMillis()-t0<1200)$.sleep(60);
            // Only remove owned temporary files AFTER the controller closed.
            if(owned.launched===false || (owned.closed && owned.closed.exists)){
                for(var i=0;owned.files && i<owned.files.length;i++){try{owned.files[i].remove();}catch(ignore){}}
                try{owned.dir.remove();}catch(ignored){}
            }else sessionLog.push('제어창 자동 닫기 확인 시간이 지났습니다. 남아 있으면 X로 닫으세요.');
        }catch(e){sessionLog.push('제어창 종료 알림: '+e);}
        finally{control=null;paused=false;workStartMs=0;}
    }
    function protectedInfo(it) {
        var style=styleKey(it);if(!style)return null;
        return {style:style,parent:it.parent};
    }
    function makeRecords(opt,st) {
        var list=opt.selected?sourceItems(true):doc.pathItems,out=[],pcount=0,total=list.length;
        for(var i=0;i<total;i++){
            if((i % UI_BATCH)===0)tick('패스 읽기 '+(i+1)+' / '+total,4+25*(i+1)/(total||1),false);
            if(quitting)break;
            if(i>=MAX_SCAN_ITEMS||out.length>=LIMIT_PATHS||pcount>=LIMIT_POINTS){st.limit=true;break;}
            var it=list[i];
            if(!isPlain(it)){st.skipped++;continue;}
            try {
                var meta=protectedInfo(it);if(!meta){st.skipped++;continue;}
                var count=it.pathPoints.length;
                if(count>LIMIT_OUTPUT||pcount+count>LIMIT_POINTS){st.skipped++;st.limit=true;continue;}
                var pts=readPts(it);if(!pts){st.skipped++;continue;}
                out.push({it:it,base:pts,p:pts,style:meta.style,parent:meta.parent,closed:!!it.closed,zero:false,dup:false,delta:0,curve:0,err:0,joined:false});
                pcount+=count;
            }catch(e){st.skipped++;}
        }
        st.pathsRead=out.length;st.pointsRead=pcount;
        return out;
    }
    function containsCurve(ps) {
        for(var z=0;z<ps.length;z++)if(d2(ps[z].a,ps[z].l)>SAME_SQ || d2(ps[z].a,ps[z].r)>SAME_SQ)return true;
        return false;
    }
    function markZeroAndSimplify(records,opt,st) {
        for(var i=0;i<records.length;i++){
            if(quitting)break;
            if((i % UI_BATCH)===0)tick('앵커 검사 '+(i+1)+' / '+records.length,30+20*(i+1)/(records.length||1),false);
            if(quitting)break;
            var rec=records[i];
            if(opt.zero && (rec.p.length<2||allZero(rec.p))) {rec.zero=true;st.zero++;continue;}
            if(opt.line && rec.p.length>=3){
                var reduction=reduceStraight(rec.p,rec.closed);
                rec.p=reduction.p;rec.delta+=reduction.deleted;st.linePoints+=reduction.deleted;
            }
            if(opt.approx && opt.selected && st.approxPaths<MAX_APPROX_PATHS && rec.p.length>2 && containsCurve(rec.p)){
                st.approxPaths++;
                var ca=approximateCurves(rec.p,rec.closed,opt.approxTol);
                rec.p=ca.p;rec.curve=ca.removed;rec.err=ca.err;st.curvePoints+=ca.removed;
            }
            if(i%UI_BATCH===0)tick('앵커 검사 '+(i+1)+' / '+records.length,30+20*(i+1)/(records.length||1));
        }
    }
    function geomHash(rec) {
        var pts=rec.p, h=[],i;
        for(i=0;i<pts.length;i++){
            if((i & 511)===0) {tick('중복 패스 좌표 확인 '+i+' / '+pts.length,58,false);if(quitting)return null;}
            var p=pts[i];h.push(quant(p.a[0]),quant(p.a[1]),quant(p.l[0]),quant(p.l[1]),quant(p.r[0]),quant(p.r[1]));
        }
        var f=h.join(','), rev=[];
        if(!rec.closed) {
            for(i=pts.length-1;i>=0;i--){var q=pts[i];rev.push(quant(q.a[0]),quant(q.a[1]),quant(q.r[0]),quant(q.r[1]),quant(q.l[0]),quant(q.l[1]));}
            var b=rev.join(',');if(b<f)f=b;
        }
        return String(pts.length)+'|'+String(rec.closed)+'|'+f;
    }
    function sameGeom(a,b) {
        if(a.closed!==b.closed||a.p.length!==b.p.length)return false;
        var n=a.p.length;
        function equalPt(x,y,reverse) {
            return d2(x.a,y.a)<=EXACT_SQ &&
                d2(x.l,reverse?y.r:y.l)<=EXACT_SQ &&
                d2(x.r,reverse?y.l:y.r)<=EXACT_SQ;
        }
        var i,yes=true;
        for(i=0;i<n;i++)if(!equalPt(a.p[i],b.p[i],false)){yes=false;break;}
        if(yes)return true;
        if(a.closed)return false; // Rotated closed shapes and mirrored offsets are preserved.
        for(i=0;i<n;i++)if(!equalPt(a.p[i],b.p[n-i-1],true))return false;
        return true;
    }
    function parentBucketKey(parent) {
        // UUID for page items; stacking ancestry also distinguishes UUID-less Layers.
        // A conservative shared fallback is safe because callers also compare references.
        var p=parent,parts=[],depth=0;
        try {
            while(p && depth++<80) {
                var uid=null;try{uid=p.uuid;}catch(ignored){}
                if(uid)return 'u'+String(uid)+'/'+parts.join('/');
                var typ=String(p.typename);
                if(typ==='Document')return 'd/'+parts.join('/');
                var z=p.zOrderPosition;
                if(typeof z!=='number'||!isFinite(z))return '?';
                parts.push(typ+':'+String(z));p=p.parent;
            }
        }catch(e){}
        return '?';
    }
    function recordBucketKey(rec) {
        if(rec.bucketKey!==undefined)return rec.bucketKey;
        var style=String(rec.style),parent=parentBucketKey(rec.parent);
        // Length prefixes keep arbitrary spot/style names from colliding structurally.
        rec.bucketKey='s'+style.length+':'+style+'p'+parent.length+':'+parent;
        return rec.bucketKey;
    }
    function removeDups(records,st,opt) {
        if(!opt.dup)return;
        var buckets={};
        for(var i=0;i<records.length;i++) {
            if((i & 63)===0){tick('중복 검사 '+(i+1)+' / '+records.length,52+14*(i+1)/(records.length||1),false);if(quitting)break;}
            var r=records[i];if(r.zero||r.p.length<2)continue;
            var k=geomHash(r);if(quitting)break;
            if(k===null)continue;
            var partition=recordBucketKey(r),key='h'+partition.length+':'+partition+k;
            var existing=buckets[key];if(!existing){buckets[key]=[i];continue;}
            var dup=false;
            for(var j=0;j<existing.length;j++){
                if((j & 255)===0){tick('중복 후보 확인 '+j+' / '+existing.length,58,false);if(quitting)break;}
                var q=records[existing[j]];
                if(q.parent===r.parent && q.style===r.style && sameGeom(q,r)){dup=true;break;}
            }
            if(quitting)break;
            if(dup){r.dup=true;st.dups++;}else existing.push(i);
        }
    }
    function inward(pts,side) {
        var i,a,b;
        if(side===0){a=pts[0].a;b=pts[0].r;if(d2(a,b)<1e-16)for(i=1;i<pts.length;i++)if(d2(a,pts[i].a)>1e-16){b=pts[i].a;break;}}
        else {i=pts.length-1;a=pts[i].a;b=pts[i].l;if(d2(a,b)<1e-16)for(i=i-1;i>=0;i--)if(d2(a,pts[i].a)>1e-16){b=pts[i].a;break;}}
        return norm(vec(a,b));
    }
    function joinCandidates(records,opt,st) {
        var active=[],ends=[],i,j;
        for(i=0;i<records.length;i++){
            if((i & 127)===0){tick('연결 대상 분류 '+(i+1)+' / '+records.length,67,false);if(quitting)return {pairs:[],ends:ends,active:active};}
            var r=records[i];if(!r.zero&&!r.dup&&!r.closed&&r.p.length>=2)active.push(i);
        }
        if(!opt.join||active.length<2)return {pairs:[],ends:ends,active:active};
        var grid={},tol=opt.joinTol,tol2=tol*tol,exact=tol===0;
        function key(part,x,y){return part.length+':'+part+'@'+String(x)+':'+String(y);}
        function coincident(a,b){return a[0]===b[0]&&a[1]===b[1];}
        function close(a,b){return exact?coincident(a,b):d2(a,b)<=tol2;}
        for(i=0;i<active.length;i++) {
            if((i & 127)===0){tick('연결 끝점 분류 '+(i+1)+' / '+active.length,69,false);if(quitting)return {pairs:[],ends:ends,active:active};}
            var idx=active[i],rr=records[idx],ps=rr.p,part=recordBucketKey(rr);
            for(j=0;j<2;j++){
                var pos=j===0?ps[0].a:ps[ps.length-1].a;
                var x=exact?pos[0]:Math.floor(pos[0]/tol),y=exact?pos[1]:Math.floor(pos[1]/tol);
                var e={id:ends.length,owner:idx,side:j,pos:pos,dir:inward(ps,j),part:part,gx:x,gy:y},k=key(part,x,y);
                ends.push(e);if(!grid[k])grid[k]=[];grid[k].push(e.id);
            }
        }
        var cand=[],degree=[],capped=false,work=0,workLimit=500000,range=exact?0:1;
        for(i=0;i<ends.length;i++)degree[i]=0;
        scan:for(i=0;i<ends.length;i++){
            if((i & 127)===0){tick('연결점 검토 '+(i+1)+' / '+ends.length,70+10*(i+1)/(ends.length||1),false);if(quitting)break;}
            var src=ends[i];
            for(var dx=-range;dx<=range;dx++)for(var dy=-range;dy<=range;dy++){
                var bucket=grid[key(src.part,exact?src.gx:src.gx+dx,exact?src.gy:src.gy+dy)];if(!bucket)continue;
                for(j=0;j<bucket.length;j++){
                    // Count examined entries, including rejected/overlapping candidates.
                    // Discard the entire graph on a cap: partial degrees cannot justify joins.
                    if(++work>workLimit){capped=true;break scan;}
                    if((work & 1023)===0){tick('끝점 후보 확인 '+work+'회',73,false);if(quitting)break scan;}
                    var id=bucket[j];if(id<=i)continue;
                    var tar=ends[id],ra=records[src.owner],rb=records[tar.owner];
                    if(src.owner===tar.owner||ra.parent!==rb.parent||ra.style!==rb.style)continue;
                    if(!close(src.pos,tar.pos))continue;
                    var A=ra.p,B=rb.p;
                    if((close(A[0].a,B[0].a)&&close(A[A.length-1].a,B[B.length-1].a))||
                       (close(A[0].a,B[B.length-1].a)&&close(A[A.length-1].a,B[0].a)))continue;
                    var dot=(src.dir&&tar.dir)?src.dir[0]*tar.dir[0]+src.dir[1]*tar.dir[1]:null;
                    if(dot!==null&&dot>0.985)continue;
                    if(cand.length>=200000){capped=true;break scan;}
                    cand.push({a:i,b:id,dist:d2(src.pos,tar.pos)});degree[i]++;degree[id]++;
                }
            }
        }
        if(capped){st.cross++;return {pairs:[],ends:ends,active:active};}
        if(quitting)return {pairs:[],ends:ends,active:active};
        var eligible=[];
        for(i=0;i<cand.length;i++){
            if((i & 1023)===0){tick('모호한 연결 제외 '+i+' / '+cand.length,81,false);if(quitting)return {pairs:[],ends:ends,active:active};}
            var candidate=cand[i];
            if(degree[candidate.a]===1&&degree[candidate.b]===1)eligible.push(candidate);
            else st.ambiguous++;
        }
        // Keep distance ordering for conservative cycle breaking; sort only usable pairs.
        eligible.sort(function(a,b){return a.dist-b.dist;});
        var root=[],sizes=[],pointCounts=[],pairs=[];
        for(i=0;i<records.length;i++){root[i]=i;sizes[i]=1;pointCounts[i]=records[i].p.length;}
        function rt(a){while(root[a]!==a){root[a]=root[root[a]];a=root[a];}return a;}
        for(i=0;i<eligible.length;i++) {
            if((i & 255)===0){tick('연결 후보 매칭 '+(i+1)+' / '+eligible.length,83,false);if(quitting)return {pairs:[],ends:ends,active:active};}
            var z=eligible[i],ar=ends[z.a].owner,br=ends[z.b].owner,aa=rt(ar),bb=rt(br);
            if(aa===bb)continue;
            var count=pointCounts[aa]+pointCounts[bb]-(d2(ends[z.a].pos,ends[z.b].pos)<=SAME_SQ?1:0);
            // Bound each synchronous host reconstruction and original-delete batch.
            if(sizes[aa]+sizes[bb]>MAX_CHAIN_SOURCES||count>LIMIT_OUTPUT)continue;
            root[aa]=bb;sizes[bb]+=sizes[aa];pointCounts[bb]=count;pairs.push(z);
        }
        st.joints=pairs.length;
        return {pairs:pairs,ends:ends,active:active};
    }
    function mergePointLists(out,next,tol) {
        var last=out[out.length-1],head=next[0];
        if(d2(last.a,head.a)>tol*tol)return false;
        if(d2(last.a,head.a)<=SAME_SQ){
            last.r=p2(head.r);
            // Last.incoming handle retained, following outgoing retained.
            for(var i=1;i<next.length;i++)out.push(clonePt(next[i]));
        } else {
            // Preserve both source anchors and their incoming/outgoing handles exactly.
            last.r=p2(last.a);
            head=clonePt(head);head.l=p2(head.a);
            out.push(head);
            for(var j=1;j<next.length;j++)out.push(clonePt(next[j]));
        }
        return true;
    }
    function planChains(records,joins,st,opt) {
        var ends=joins.ends,pairs=joins.pairs,matched=[],visited=[],plans=[],i;
        for(i=0;i<ends.length;i++)matched[i]=-1;
        for(i=0;i<pairs.length;i++){var p=pairs[i];matched[p.a]=p.b;matched[p.b]=p.a;}
        for(i=0;i<records.length;i++)visited[i]=false;
        function walk(start) {
            var id=start,src=[],pts=[],steps=0;
            while(id!==-1&&steps++<records.length) {
                if((steps & 15)===0){tick('연속 패스 계획 '+steps+'구간',85,false);if(quitting)return null;}
                var ref=ends[id],r=records[ref.owner];
                if(visited[ref.owner])return null;
                visited[ref.owner]=true;src.push(ref.owner);
                var oriented=ref.side===0?clonePts(r.p):reversePts(r.p);
                if(pts.length===0)pts=oriented;
                else if(!mergePointLists(pts,oriented,opt.joinTol))return null;
                if(pts.length>LIMIT_OUTPUT||src.length>MAX_CHAIN_SOURCES)return null;
                id=matched[id%2===0?id+1:id-1];
            }
            // Reaching exactly records.length is valid when the chain terminates.
            if(id!==-1)return null;
            return {src:src,points:pts,closed:false,joins:Math.max(0,src.length-1)};
        }
        for(i=0;i<ends.length;i++) {
            if((i & 127)===0){tick('연결 계획 구성 '+(i+1)+' / '+ends.length,86,false);if(quitting)break;}
            var owner=ends[i].owner;
            if(visited[owner]||matched[i]!==-1)continue;
            var plan=walk(i);if(plan&&plan.src.length>1){plans.push(plan);for(var q=0;q<plan.src.length;q++)records[plan.src[q]].joined=true;}
        }
        st.chains=plans.length;return plans;
    }
    function analyze(opt) {
        var st=noopStats(),result=null;startProgress('분석 중');
        try {
            if(quitting)return null;
            var rec=makeRecords(opt,st);
            if(!quitting){markZeroAndSimplify(rec,opt,st);removeDups(rec,st,opt);}
            var joins=(!quitting&&!st.limit)?joinCandidates(rec,opt,st):{pairs:[],ends:[],active:[]};
            var plans=(!quitting)?planChains(rec,joins,st,opt):[];
            if(!quitting){
                var singles=[];
                for(var i=0;i<rec.length;i++){
                    if((i % UI_BATCH)===0)tick('정리 계획 마무리 '+i+' / '+rec.length,92,false);
                    if(quitting)break;
                    var r=rec[i];
                    if(!r.zero&&!r.dup&&!r.joined&&r.p.length!==r.base.length)
                        singles.push({src:[i],points:r.p,closed:r.closed,joins:0});
                }
                if(opt.groups && !quitting){
                    var count=doc.groupItems.length;
                    for(var k=0;k<count && k<MAX_SCAN_ITEMS;k++){
                        if((k % UI_BATCH)===0)tick('빈 그룹 예상 확인 '+k+' / '+count,95,false);
                        if(quitting)break;
                        if(isEditableGroup(doc.groupItems[k]))st.emptyGroups++;
                    }
                    if(count>MAX_SCAN_ITEMS)st.limit=true;
                }
                if(!quitting)result={records:rec,plans:plans.concat(singles),stats:st,opt:opt};
            }
        }catch(e){sessionLog.push('분석 오류: '+e);}
        finally{endProgress(quitting?'stopped':(result?'done':'error'),'검사 단계 종료');}
        if(quitting){alert('분석이 중단되었습니다. 원본은 변경되지 않았습니다.\n'+stopReason);return null;}
        if(!result){alert('분석이 완료되지 않았습니다. 원본 변경 없음.\n'+sessionLog.join('\n'));return null;}
        return result;
    }
    function applyPoints(newItem,points,closed) {
        var coords=[],i;
        for(i=0;i<points.length;i++) {
            if((i & 255)===0) {tick('새 패스 좌표 준비 '+i+' / '+points.length,45,false);if(quitting)throw Error('USER_STOP');}
            coords.push(p2(points[i].a));
        }
        newItem.setEntirePath(coords);
        newItem.closed=closed;
        newItem.filled=false;
        var ps=newItem.pathPoints;
        if(ps.length!==points.length)throw Error('앵커 개수 검증 실패');
        for(i=0;i<points.length;i++){
            if((i & 127)===0) {tick('새 패스 곡선 복원 '+i+' / '+points.length,62,false);if(quitting)throw Error('USER_STOP');}
            var a=ps[i],b=points[i];
            try{a.pointType=b.t;}catch(e){a.pointType=PointType.CORNER;}
            if(b.l[0]!==b.a[0]||b.l[1]!==b.a[1])a.leftDirection=p2(b.l);
            if(b.r[0]!==b.a[0]||b.r[1]!==b.a[1])a.rightDirection=p2(b.r);
        }
        for(i=0;i<points.length;i++) {
            if((i & 255)===0) {tick('새 패스 최종 확인 '+i+' / '+points.length,70,false);if(quitting)throw Error('USER_STOP');}
            if(d2(ps[i].anchor,points[i].a)>EXACT_SQ || d2(ps[i].leftDirection,points[i].l)>EXACT_SQ || d2(ps[i].rightDirection,points[i].r)>EXACT_SQ)throw Error('좌표/곡선 핸들 검증 실패');
        }
        if(newItem.closed!==closed||newItem.filled||!newItem.stroked)throw Error('획 속성 검증 실패');
    }
    function commit(plan,records) {
        if(quitting)return 'stopped';
        if(plan.points.length<2||plan.points.length>LIMIT_OUTPUT||plan.src.length>MAX_CHAIN_SOURCES)return 'failed';
        var first,copy=null,i;
        try {
            first=records[plan.src[0]].it;
            copy=first.duplicate();
            applyPoints(copy,plan.points,plan.closed);
            if(quitting)throw Error('USER_STOP');
        }catch(e){
            // The new path is incomplete: remove ONLY the copy, preserve ALL originals.
            try{if(copy)copy.remove();}catch(rollbackError){rollbackErrors++;sessionLog.push('미완성 복제본 제거 실패 — 문서를 확인하세요: '+rollbackError);}
            if(quitting||String(e).indexOf('USER_STOP')>=0)return 'stopped';
            sessionLog.push('새 패스 생성 실패: '+e);return 'failed';
        }
        // One logical commit: finish deleting originals even if Stop was clicked
        // while this small delete loop was running. Do not leave half a chain by choice.
        var deleteErrors=0;
        for(i=0;i<plan.src.length;i++){
            try{records[plan.src[i]].it.remove();}
            catch(e){deleteErrors++;sessionLog.push('원본 삭제 실패(중복 가능): '+e);}
        }
        if(deleteErrors)sessionLog.push('한 연속 패스의 일부 원본 삭제 실패 '+deleteErrors+'개 — 도면 확인 필요');
        operationsDone++;
        return deleteErrors?'partial':'done';
    }
    function deleteSafe(rec) {
        if(quitting)return false;
        try{rec.it.remove();operationsDone++;return true;}
        catch(e){sessionLog.push('삭제 보류: '+e);return false;}
    }
    function cleanEmptyGroups(prep) {
        var allowed=[],rr,p,allowedOnly=!!prep.opt.selected;
        if(allowedOnly){
            for(var q=0;q<prep.records.length;q++){
                if((q % UI_BATCH)===0){tick('선택 그룹 범위 확인 '+q,96,false);if(quitting)return 0;}
                rr=prep.records[q];p=rr.parent;
                while(p && p.typename!=="Document"){
                    if(p.typename==="GroupItem") {
                        var found=false;for(var x=0;x<allowed.length;x++)if(allowed[x]===p){found=true;break;}
                        if(!found)allowed.push(p);
                    }
                    p=p.parent;
                }
            }
        }
        function allowedGroup(g){
            if(!allowedOnly)return true;
            for(var a=0;a<allowed.length;a++)if(allowed[a]===g)return true;
            return false;
        }
        var removed=0,round;
        for(round=0;round<12;round++){
            var count=0,groups=[];
            try{var groupCount=doc.groupItems.length;for(var i=0;i<groupCount&&i<MAX_SCAN_ITEMS;i++){if((i % UI_BATCH)===0){tick('빈 그룹 목록 읽기 '+i+' / '+groupCount,96,false);if(quitting)break;}groups.push(doc.groupItems[i]);}}catch(e){break;}
            for(var j=groups.length-1;j>=0;j--) {
                if((j & 31)===0)tick('빈 그룹 확인 '+(groups.length-j)+' / '+groups.length,96,false);
                if(quitting)break;
                if(allowedGroup(groups[j]) && isEditableGroup(groups[j])) {
                    try{groups[j].remove();removed++;count++;operationsDone++;}catch(ign){}
                }
            }
            if(count===0||quitting)break;
        }
        return removed;
    }
    function applyPlan(prep) {
        var st=prep.stats,records=prep.records,ops=prep.plans;
        var done={paths:0,removed:0,zero:0,dup:0,groups:0,failed:0,joins:0,linePoints:0,curvePoints:0,partial:0};
        var deletes=[],i,j,outcome,phase='연속 선 재구성';
        startProgress('정리 적용 중');
        try {
            if(quitting)return;
            // Poll BEFORE actual work. Nothing may enter a pause after the final mutation.
            for(i=0;i<ops.length;i++){
                tick('1/3 선 정리 '+(i+1)+' / '+ops.length,6+70*i/(ops.length||1),false);
                if(quitting)break;
                outcome=commit(ops[i],records);
                if(outcome==='done'){
                    done.paths++;done.joins+=ops[i].joins;
                    for(var k=0;k<ops[i].src.length;k++){
                        var committed=records[ops[i].src[k]];
                        done.linePoints+=committed.delta||0;done.curvePoints+=committed.curve||0;
                    }
                }else if(outcome==='partial'){done.partial++;done.failed++;}
                else if(outcome==='stopped')break;
                else done.failed++;
            }
            if(!quitting){
                phase='0 길이·중복선 삭제';
                for(i=0;i<records.length;i++)if(records[i].zero||records[i].dup)deletes.push(records[i]);
                for(j=0;j<deletes.length;j++){
                    tick('2/3 중복·찌꺼기 삭제 '+(j+1)+' / '+deletes.length,77+18*j/(deletes.length||1),false);
                    if(quitting)break;
                    var r=deletes[j];
                    if(deleteSafe(r)){if(r.zero)done.zero++;else done.dup++;done.removed++;}
                    else done.failed++;
                }
            }
            if(!quitting && prep.opt.groups){phase='빈 그룹 정리';done.groups=cleanEmptyGroups(prep);}
        }catch(e){done.failed++;sessionLog.push('단계 '+phase+' 오류: '+e);}
        finally{done.failed+=rollbackErrors;endProgress(quitting?'stopped':(done.failed?'error':'done'),'정리 단계 종료');}
        var hadChanges=operationsDone>0;
        var msg='CAD Light Cleaner v'+VERSION+(quitting?' | 안전 중단 · 부분 적용':(done.failed?' | 완료 · 오류 확인 필요':' | 정리 완료'))+'\n\n'+
            '검사: '+st.pathsRead+'패스 / 원래 앵커 '+st.pointsRead+'개\n'+
            '완료 — 재구성 패스 '+done.paths+'개 / 연결 '+done.joins+'곳\n'+
            '완료 — 0 길이 '+done.zero+'개 / 중복 '+done.dup+'개 / 빈 그룹 '+done.groups+'개 삭제\n'+
            '완료 — 직선 앵커 '+done.linePoints+'개 / 곡선 앵커 '+done.curvePoints+'개 감소\n'+
            '완료 처리 '+operationsDone+'건 / 실패 '+done.failed+'건 / 보호·제외 '+st.skipped+'개';
        if(done.partial)msg+='\n일부 원본 삭제 실패 '+done.partial+'개 재구성 — 중복 잔여 가능, 문서를 확인하세요.';
        if(rollbackErrors)msg+='\n미완성 복제본 제거 실패 '+rollbackErrors+'건 — 문서를 확인하세요.';
        if(st.limit)msg+='\n한도로 일부 항목을 보류했습니다. 연결 검사는 보류될 수 있습니다.';
        if(quitting)msg+='\n\n'+stopReason+(rollbackErrors?'\n중단 전 변경 내역과 잔여 복제본을 확인하세요.':'\n완료된 작업만 유지했고 미완성 복제본은 폐기했습니다.');
        if(!hadChanges)msg+='\n문서에 적용한 변경이 없습니다.';
        if(hadChanges)msg+='\n\n원본 파일은 자동 저장하지 않았습니다. 결과 확인 후 새 이름으로 저장하세요.\nCtrl+Z 한 번으로 전체 복구가 보장되지는 않습니다. 실행 전 저장한 사본으로 복구할 수 있습니다.';
        if(sessionLog.length)msg+='\n\n알림: '+sessionLog.slice(0,5).join(' | ');
        alert(msg);
    }
    // ----------------- In-dialog curve comparison without doc mutation -----------------
    function curveExamples(opt) {
        if(!opt.selected)return {error:'선택된 개체가 있어야 곡선 미리보기를 볼 수 있습니다.'};
        startProgress('곡선 미리보기 계산');
        var tested=0,examples=[];
        try {
            if(quitting)return {error:'미리보기 제어창을 시작하지 못했습니다.'};
            var list=sourceItems(true);
            for(var i=0;i<list.length;i++){
                if((i % UI_BATCH)===0)tick('미리보기 대상 확인 '+(i+1),25,false);
                if(quitting)break;
                if(!isPlain(list[i]))continue;
                var pts=readPts(list[i]);if(!pts||pts.length<3||pts.length>MAX_PREVIEW_POINTS||list[i].closed)continue;
                tested++;
                var reduced=approximateCurves(pts,false,opt.approxTol);
                if(reduced.removed>0)examples.push({before:pts,after:reduced.p,removed:reduced.removed,err:reduced.err,examined:tested});
                if(tested>=30||examples.length>=5)break;
            }
        }finally{endProgress(quitting?'stopped':'done','미리보기 단계 종료');}
        if(quitting)return {error:'미리보기가 중단되었습니다. 원본 변경 없음. '+stopReason};
        return examples.length?{items:examples}:{error:'지정 오차 이내로 안전하게 줄일 수 있는 열린 곡선을 찾지 못했습니다. 원본 형상을 보존합니다.'};
    }
    function viewBounds(pts) {
        var left=1e30,right=-1e30,top=-1e30,bottom=1e30;
        var samples=polyline(pts,false,12);
        for(var i=0;i<samples.length;i++){var p=samples[i];left=Math.min(left,p[0]);right=Math.max(right,p[0]);bottom=Math.min(bottom,p[1]);top=Math.max(top,p[1]);}
        return {left:left,right:right,top:top,bottom:bottom};
    }
    function polyline(pts,closed,steps) {
        var out=[];if(!pts||pts.length===0)return out;
        for(var i=0;i<pts.length-1;i++){
            var seg=sampledSegment(pts[i],pts[i+1],steps);
            for(var j=0;j<seg.length-1;j++)out.push(seg[j]);
        }
        out.push(p2(pts[pts.length-1].a));
        if(closed){var last=sampledSegment(pts[pts.length-1],pts[0],steps);for(var z=1;z<last.length;z++)out.push(last[z]);}
        return out;
    }
    function drawCurve(control,points,box) {
        if(!points)return;
        try{
            var g=control.graphics,size=control.size,W=size.width||265,H=size.height||140;
            var P=polyline(points,false,12),rx=Math.max(1e-9,box.right-box.left),ry=Math.max(1e-9,box.top-box.bottom);
            var scale=Math.min((W-24)/rx,(H-24)/ry), cx=(box.left+box.right)/2,cy=(box.top+box.bottom)/2;
            g.newPath();
            for(var i=0;i<P.length;i++){
                var x=W/2+(P[i][0]-cx)*scale,y=H/2-(P[i][1]-cy)*scale;
                if(i===0)g.moveto(x,y);else g.lineto(x,y);
            }
            var pen=g.newPen(g.PenType.SOLID_COLOR,control._isNew?[0.06,0.70,0.82,1]:[0.52,0.53,0.56,1],2);
            g.strokePath(pen);
        }catch(e){}
    }
    function selectedAvailable() {try{return !!(doc.selection && doc.selection.length>0);}catch(e){return false;}}
    var ui=new Window('dialog','Illustrator CAD Light Cleaner v'+VERSION);
    ui.orientation='column';ui.alignChildren=['fill','top'];ui.spacing=9;ui.margins=16;
    ui.add('statictext',undefined,'빠른 기본값: 중복·0 길이·직선 앵커 | 연결·빈 그룹은 필요할 때 선택 | 단계별 45초 한도');
    var scope=ui.add('panel',undefined,'검사 범위');scope.orientation='row';scope.alignChildren='left';
    var selRadio=scope.add('radiobutton',undefined,'현재 선택 영역');
    var docRadio=scope.add('radiobutton',undefined,'문서 전체');
    selRadio.value=selectedAvailable();docRadio.value=!selRadio.value;
    if(!selectedAvailable())selRadio.enabled=false;
    var opts=ui.add('panel',undefined,'정리 기능');opts.orientation='column';opts.alignChildren='left';
    var chDup=opts.add('checkbox',undefined,'정확한 중복 선 삭제 (같은 그룹·획 속성)');chDup.value=true;
    var chZero=opts.add('checkbox',undefined,'0 길이 패스 / 1점 찌꺼기 삭제');chZero.value=true;
    var chLine=opts.add('checkbox',undefined,'직선상의 불필요한 앵커 제거 (기하 오차 극소)');chLine.value=true;
    var rowJoin=opts.add('group');rowJoin.orientation='row';
    var chJoin=rowJoin.add('checkbox',undefined,'끝점 근접 연결 / PLINE형 열린 패스');chJoin.value=false;
    rowJoin.add('statictext',undefined,'거리 mm (0=일치):');
    var tolInput=rowJoin.add('edittext',undefined,'0.000');tolInput.characters=7;
    var chGroups=opts.add('checkbox',undefined,'완전히 비어 있는 그룹만 제거 (레이어 보존)');chGroups.value=false;
    var approxPanel=ui.add('panel',undefined,'곡선 근사 단순화 (선택 항목만 · 기본 OFF)');
    approxPanel.orientation='column';approxPanel.alignChildren='left';
    var curveRow=approxPanel.add('group');
    var chApprox=curveRow.add('checkbox',undefined,'곡선 근사 허용');chApprox.value=false;
    curveRow.add('statictext',undefined,'샘플 측정 오차 pt:');
    var curveTol=curveRow.add('edittext',undefined,'0.05');curveTol.characters=7;
    var curveMsg=approxPanel.add('statictext',undefined,'코너·닫힌 패스 제외. 선택 개체의 완만한 열린 곡선만 분석.');
    var prevButtons=approxPanel.add('group');
    var prevBtn=prevButtons.add('button',undefined,'선택 곡선 비교 미리보기');
    var nextCurveBtn=prevButtons.add('button',undefined,'다음 곡선');nextCurveBtn.enabled=false;
    var prevInfo=approxPanel.add('statictext',undefined,'미리보기는 Illustrator 문서를 변경하지 않습니다.');
    var prevViews=approxPanel.add('group');prevViews.orientation='row';
    var origCol=prevViews.add('group');origCol.orientation='column';
    origCol.add('statictext',undefined,'원본 (회색)');
    var origView=origCol.add('customView',undefined,[0,0,255,125]);origView.preferredSize=[255,125];origView._isNew=false;
    var newCol=prevViews.add('group');newCol.orientation='column';
    newCol.add('statictext',undefined,'단순화 결과 (파랑)');
    var newView=newCol.add('customView',undefined,[0,0,255,125]);newView.preferredSize=[255,125];newView._isNew=true;
    var previewModel=null,previewList=[],previewIndex=0;
    origView.onDraw=function(){if(previewModel)drawCurve(origView,previewModel.before,previewModel.bounds);};
    newView.onDraw=function(){if(previewModel)drawCurve(newView,previewModel.after,previewModel.bounds);};
    var message=ui.add('edittext',undefined,'① 검사/예상 → ② 정리 실행 → ③ 별도 Windows 제어창에서 일시정지/재개/중단\n일반 JSX 계산 중 Illustrator 편집은 불가능 · Ctrl+Z 전체 1회 복구 보장 불가', {multiline:true,readonly:true});
    message.preferredSize=[565,125];
    var btns=ui.add('group');btns.alignment='right';
    var auditBtn=btns.add('button',undefined,'1. 검사 / 예상');
    var runBtn=btns.add('button',undefined,'2. 정리 실행');runBtn.enabled=false;
    var closeBtn=btns.add('button',undefined,'닫기',{name:'cancel'});
    function readNumber(t,low,high,label) {
        var str=String(t.text).replace(/,/g,'.').replace(/^\s+|\s+$/g,'');
        if(!/^(?:\d+\.?\d*|\.\d+)$/.test(str))throw Error(label+'에 올바른 숫자를 입력하세요.');
        var v=Number(str);if(!isFinite(v)||v<low||v>high)throw Error(label+' 범위: '+low+'~'+high);
        return v;
    }
    function settings() {
        var mm=readNumber(tolInput,0,3,'끝점 허용 거리 mm');
        if(Math.abs(mm*1000-Math.round(mm*1000))>0.000001)throw Error('끝점 거리는 0.001mm 단위로 입력하세요. 0은 완전 일치만 연결합니다.');
        return {selected:!!selRadio.value,dup:!!chDup.value,zero:!!chZero.value,line:!!chLine.value,
            join:!!chJoin.value,joinTol:mm*72/25.4,
            groups:!!chGroups.value,approx:!!chApprox.value,approxTol:readNumber(curveTol,0.0001,5,'곡선 샘플 오차')};
    }
    function optKey(o) {return [o.selected,o.dup,o.zero,o.line,o.join,o.joinTol,o.groups,o.approx,o.approxTol].join('|');}
    function invalidate(){prepared=null;runBtn.enabled=false;previewModel=null;previewList=[];nextCurveBtn.enabled=false;prevInfo.text='설정이 변경됐습니다. 다시 검사하세요.';}
    var changes=[selRadio,docRadio,chDup,chZero,chLine,chJoin,tolInput,chGroups,chApprox,curveTol];
    for(var change=0;change<changes.length;change++)changes[change].onClick=invalidate;
    tolInput.onChanging=invalidate;curveTol.onChanging=invalidate;
    function showPreviewModel() {
        if(!previewList.length)return;
        var v=previewList[previewIndex];v.bounds=viewBounds(v.before);previewModel=v;
        prevInfo.text='예시 '+(previewIndex+1)+' / '+previewList.length+' : '+v.before.length+' → '+v.after.length+'점 (−'+v.removed+'), 측정 누적 오차 약 '+v.err.toFixed(5)+'pt';
        origView.notify('onDraw');newView.notify('onDraw');
    }
    prevBtn.onClick=function(){
        try {
            var opt=settings(),r=curveExamples(opt);
            if(r.error){previewModel=null;previewList=[];nextCurveBtn.enabled=false;prevInfo.text=r.error;origView.notify('onDraw');newView.notify('onDraw');return;}
            previewList=r.items;previewIndex=0;nextCurveBtn.enabled=previewList.length>1;
            showPreviewModel();
        } catch(e){alert('미리보기 오류: '+e);}
    };
    nextCurveBtn.onClick=function(){if(previewList.length){previewIndex=(previewIndex+1)%previewList.length;showPreviewModel();}};
    auditBtn.onClick=function(){
        try{
            var o=settings();if(o.approx&&!o.selected)throw Error('곡선 근사는 현재 선택 영역만 대상으로 합니다. 선택 영역을 지정하거나 곡선 옵션을 끄세요.');
            if(o.joinTol>2&&!confirm('연결 허용 거리가 큽니다. 무관한 선이 이어질 수 있습니다. 계속할까요?'))return;
            prepared=analyze(o);if(!prepared)return;
            var s=prepared.stats;
            message.text='검사 완료 · 아직 적용 전입니다. 아래 2. 정리 실행을 누르세요.\n검사 대상: '+s.pathsRead+'패스 / '+s.pointsRead+'앵커\n'+
                '예상 0 길이: '+s.zero+'개 | 정확 중복: '+s.dups+'개\n'+
                '예상 불필요한 직선 앵커: '+s.linePoints+'개 | 곡선 앵커: '+s.curvePoints+'개\n'+
                '연결 후보: '+s.joints+'곳, 재구성될 연속 패스: '+s.chains+'개\n'+
                '현재 빈 그룹: '+s.emptyGroups+'개 | 보호/건너뜀: '+s.skipped+'개\n'+
                (s.limit?'⚠ 대용량 한도 도달: 선택 범위를 나눠 반복 실행 필요\n':'')+
                (s.approxPaths>=MAX_APPROX_PATHS?'곡선 근사 처리 한도: '+MAX_APPROX_PATHS+'패스 (나머지 보류)\n':'')+
                '원본은 아직 수정되지 않았습니다.';
            runBtn.enabled=true;
            if(s.zero+s.dups+s.linePoints+s.curvePoints+s.joints===0 && (!o.groups||s.emptyGroups===0)){
                prepared=null;ui.close(0);alert('검사 완료 — 정리할 대상이 없습니다. 원본 변경 없음.');
            }
        }catch(e){alert('설정/검사 오류: '+e);}
    };
    runBtn.onClick=function(){
        try {
            var opt=settings();
            if(!prepared||optKey(opt)!==optKey(prepared.opt)){alert('설정이 변경됐습니다. 다시 검사/예상을 실행하세요.');invalidate();return;}
            var s=prepared.stats,total=s.zero+s.dups+s.linePoints+s.curvePoints+s.joints;
            if(total===0&&(!opt.groups||s.emptyGroups===0)){ui.close(0);alert('검사 완료 — 변경 대상이 없습니다.');return;}
            if(!confirm('검사 결과를 실제 문서에 적용합니다.\nWindows 외부 제어창에서 중단/일시정지가 가능합니다.\nCtrl+Z 한 번으로 원상복구되는지는 Illustrator에서 보장되지 않습니다.\n반드시 복사본을 만들어 두세요.\n\n연결 '+s.joints+'곳 · 중복 '+s.dups+'개 · 찌꺼기 '+s.zero+'개\n진행할까요?'))return;
            ui.close(1);
        }catch(e){alert('실행 전 오류: '+e);}
    };
    closeBtn.onClick=function(){ui.close(0);};
    var answer=ui.show();
    if(answer!==1||!prepared)return;
    applyPlan(prepared);
})();
