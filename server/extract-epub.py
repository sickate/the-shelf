import sys, zipfile, posixpath, json, xml.etree.ElementTree as ET
from html.parser import HTMLParser
class Text(HTMLParser):
 def __init__(self): super().__init__(); self.parts=[]; self.skip=0
 def handle_starttag(self,t,a):
  if t in ('script','style'): self.skip+=1
 def handle_endtag(self,t):
  if t in ('script','style'): self.skip=max(0,self.skip-1)
  if t in ('p','div','h1','h2','br'): self.parts.append('\n')
 def handle_data(self,d):
  if not self.skip: self.parts.append(d)
with zipfile.ZipFile(sys.argv[1]) as z:
 if len(z.infolist())>10000 or sum(i.file_size for i in z.infolist())>40000000: raise ValueError('archive_too_large')
 def read(name):
  if name.startswith('/') or '..' in name.split('/'): raise ValueError('unsafe_archive_path')
  data=z.read(name)
  if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper(): raise ValueError('unsafe_xml')
  return data
 container=ET.fromstring(read('META-INF/container.xml'))
 opf=next(x.attrib['full-path'] for x in container.iter() if x.tag.endswith('rootfile'))
 tree=ET.fromstring(read(opf)); items={x.attrib['id']:x.attrib.get('href','') for x in tree.iter() if x.tag.endswith('}item')}
 result=[]
 for item in tree.iter():
  if item.tag.endswith('}itemref'):
   name=posixpath.normpath(posixpath.join(posixpath.dirname(opf),items[item.attrib['idref']]))
   parser=Text();parser.feed(read(name).decode('utf-8',errors='replace'))
   result.append({'label':'章节 '+str(len(result)+1),'text':''.join(parser.parts)})
 print(json.dumps(result,ensure_ascii=False))
