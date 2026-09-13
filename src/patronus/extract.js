import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { displayURL } from './network.js';
export function extract(html,url) {
  const {document}=parseHTML(html); const title=document.querySelector('title')?.textContent||'';
  const links=[],images=[];
  for(const el of document.querySelectorAll('script,style,noscript,template,input,textarea')) el.remove();
  for(const a of document.querySelectorAll('a[href]')) {
    try{const full=new URL(a.getAttribute('href'),url);if(!['https:','http:'].includes(full.protocol)){a.removeAttribute('href');continue;}
      links.push({text:a.textContent.trim(),url:full.href});a.setAttribute('href',displayURL(full.href));
    }catch{a.removeAttribute('href');}
  }
  for(const [i,img] of [...document.querySelectorAll('img')].entries()) {
    try{const src=new URL(img.getAttribute('src')||'',url).href;
      images.push({id:'image-'+i,url:src,alt:img.getAttribute('alt')||'',caption:img.closest('figure')?.querySelector('figcaption')?.textContent||'',source:'page'});
      img.setAttribute('src','patronus-image:'+i);
    }catch{}
  }
  const converter=new TurndownService({headingStyle:'atx'});converter.use(gfm);
  let markdown=converter.turndown(document.body?.innerHTML||html);
  const truncated=markdown.length>500000;markdown=markdown.slice(0,500000);
  return {title,markdown,links,images,coverage:{textTruncated:truncated,iframes:document.querySelectorAll('iframe').length,scope:'Rendered/extracted document; unvisited links and frames are not claimed complete.'}};
}
