// Controlled retained-copy memory fixture, not an upstream limit probe.
// Each case runs in a fresh, bounded child; never call production routes.
import { spawnSync } from 'node:child_process';
if (!process.argv.includes('--child')) {
  for (const kind of ['ascii','escaped','utf8','base64','zeros','objects','arrays']) {
    for (const size of (['objects','arrays'].includes(kind) ? [524288,1048576] : [524288,2027125,4194304])) {
      const child=spawnSync(process.execPath,['--expose-gc','--max-old-space-size=192',import.meta.filename,'--child',kind,String(size)],{encoding:'utf8',timeout:30000});
      if(child.status!==0) throw Error(child.stderr || 'Measurement child failed');
      process.stdout.write(child.stdout);
    }
  }
} else {
  global.gc();
  const baseline=process.memoryUsage().rss, start=performance.now();
  const kind=process.argv[3],size=+process.argv[4];
  const atom=kind==='escaped'?'\n"\\':kind==='utf8'?'😀é':kind==='base64'?'YWJj':'a';
  const content=kind==='zeros'?Array(Math.floor(size/2)).fill(0)
    :kind==='objects'?Array.from({length:Math.floor(size/3)},()=>({}))
    :kind==='arrays'?Array.from({length:Math.floor(size/3)},()=>[])
    :atom.repeat(Math.ceil(size/(kind==='utf8'?6:kind==='escaped'?6:kind==='base64'?4:1)));
  const wire=Buffer.from(JSON.stringify({action:'host_file_write',args:{content}}));
  const front=JSON.parse(wire.toString('utf8'));
  const forwarded=JSON.stringify(front);
  const backendWire=Buffer.from(forwarded);
  const backend=JSON.parse(backendWire.toString('utf8'));
  // Retain every copy through the final sample, including synthetic client input.
  const peakRss=process.resourceUsage().maxRSS*1024;
  console.log(JSON.stringify({kind,targetBytes:size,wireBytes:wire.length,baselineRss:baseline,peakRss,
    incrementalRssPerWireByte:(peakRss-baseline)/wire.length,rss:process.memoryUsage().rss,
    heap:process.memoryUsage().heapUsed,latencyMs:performance.now()-start,
    retainedCopies:!!(content&&front&&forwarded&&backendWire&&backend),node:process.version}));
}
