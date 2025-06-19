'use client'

import { MDXLayoutRenderer } from 'pliny/mdx-components'
import { components } from '@/components/MDXComponents'

export default function ClientMdxRenderer({ code, toc }) {
  return <MDXLayoutRenderer code={code} components={components} toc={toc} />
}
