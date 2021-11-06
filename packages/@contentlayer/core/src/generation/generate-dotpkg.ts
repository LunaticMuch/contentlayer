import * as utils from '@contentlayer/utils'
import type { E, HasClock } from '@contentlayer/utils/effect'
import { flow, OT, pipe, S, T } from '@contentlayer/utils/effect'
import { fs } from '@contentlayer/utils/node'
import { camelCase } from 'camel-case'
import { promises as fsPromise } from 'fs'
import * as path from 'path'
import type { PackageJson } from 'type-fest'

import { ArtifactsDir } from '../ArtifactsDir.js'
import type { DataCache } from '../DataCache.js'
import type { SourceProvideSchemaError } from '../errors.js'
import type { SourceFetchDataError } from '../index.js'
import type { PluginOptions, SourcePlugin, SourcePluginType } from '../plugin.js'
import type { DocumentTypeDef, SchemaDef } from '../schema/index.js'
import { autogeneratedNote } from './common.js'
import { renderTypes } from './generate-types.js'

/**
 * Used to track which files already have been written.
 * Gets re-initialized per `generateDotpkg` invocation therefore only "works" during dev mode.
 */
type FilePath = string
type DocumentHash = string
type WrittenFilesCache = Record<FilePath, DocumentHash>

export type GenerationOptions = {
  sourcePluginType: SourcePluginType
  options: PluginOptions
}

type GenerateDotpkgError = fs.UnknownFSError | fs.MkdirError | SourceProvideSchemaError | SourceFetchDataError

export type GenerateInfo = {
  documentCount: number
}

export const logGenerateInfo = (info: GenerateInfo): T.Effect<unknown, never, void> =>
  T.log(`Generated ${info.documentCount} documents in node_modules/.contentlayer`)

export const generateDotpkg = ({
  source,
  verbose,
  cwd,
}: {
  source: SourcePlugin
  verbose: boolean
  cwd: string
}): T.Effect<OT.HasTracer & HasClock, GenerateDotpkgError, GenerateInfo> =>
  pipe(
    generateDotpkgStream({ source, verbose, cwd }),
    S.take(1),
    S.runCollect,
    T.map((_) => _[0]!),
    T.rightOrFail,
    OT.withSpan('@contentlayer/core/generation:generateDotpkg', { attributes: {} }),
  )

// TODO make sure unused old generated files are removed
export const generateDotpkgStream = ({
  source,
  verbose,
  cwd,
}: {
  source: SourcePlugin
  verbose: boolean
  cwd: string
}): S.Stream<OT.HasTracer & HasClock, never, E.Either<GenerateDotpkgError, GenerateInfo>> => {
  const writtenFilesCache = {}
  const generationOptions = { sourcePluginType: source.type, options: source.options }
  const resolveParams = pipe(
    T.structPar({
      schemaDef: source.provideSchema,
      targetPath: ArtifactsDir.mkdir({ cwd }),
    }),
    T.either,
  )

  // .pipe(
  //   tap((artifactsDir) => watchData && errorIfArtifactsDirIsDeleted({ artifactsDir }))
  // ),

  return pipe(
    S.fromEffect(resolveParams),
    S.chainMapEitherRight(({ schemaDef, targetPath }) =>
      pipe(
        source.fetchData({ schemaDef, verbose, cwd }),
        S.mapEffectEitherRight((cache) =>
          pipe(
            writeFilesForCache({ schemaDef, targetPath, cache, generationOptions, writtenFilesCache }),
            T.eitherMap(() => ({ documentCount: Object.keys(cache.cacheItemsMap).length })),
          ),
        ),
      ),
    ),
  )
}

const writeFilesForCache = (params: {
  schemaDef: SchemaDef
  cache: DataCache.Cache
  targetPath: string
  generationOptions: GenerationOptions
  writtenFilesCache: WrittenFilesCache
}): T.Effect<OT.HasTracer, never, E.Either<fs.UnknownFSError, void>> =>
  pipe(
    T.tryCatchPromise(
      () => writeFilesForCache_(params),
      (error) => new fs.UnknownFSError({ error }),
    ),
    OT.withSpan('@contentlayer/core/generation:writeFilesForCache', {
      attributes: { targetPath: params.targetPath },
    }),
    T.either,
  )

const writeFilesForCache_ = async ({
  cache,
  schemaDef,
  targetPath,
  generationOptions,
  writtenFilesCache,
}: {
  schemaDef: SchemaDef
  cache: DataCache.Cache
  targetPath: string
  generationOptions: GenerationOptions
  writtenFilesCache: WrittenFilesCache
}): Promise<void> => {
  const withPrefix = (...path_: string[]) => path.join(targetPath, ...path_)

  if (process.env['CL_DEBUG']) {
    // NOTE cache directory already exists because `source.fetchData` has already created it
    await fsPromise.mkdir(withPrefix('cache'), { recursive: true })
    await fsPromise.writeFile(withPrefix('cache', 'schema.json'), JSON.stringify(schemaDef, null, 2))
    await fsPromise.writeFile(withPrefix('cache', 'data-cache.json'), JSON.stringify(cache, null, 2))
  }

  const allCacheItems = Object.values(cache.cacheItemsMap)
  const allDocuments = allCacheItems.map((_) => _.document)

  const documentDefs = Object.values(schemaDef.documentTypeDefMap)

  const typeNameField = generationOptions.options.fieldOptions.typeFieldName
  const dataBarrelFiles = documentDefs.map((docDef) => ({
    content: makeDataExportFile({
      docDef,
      documentIds: allDocuments.filter((_) => _[typeNameField] === docDef.name).map((_) => _._id),
    }),
    filePath: withPrefix('data', `${getDataVariableName({ docDef })}.mjs`),
  }))

  const dataJsonFiles = allCacheItems.map(({ document, documentHash }) => ({
    content: JSON.stringify(document, null, 2),
    filePath: withPrefix('data', document[typeNameField], `${idToFileName(document._id)}.json`),
    documentHash,
  }))

  const dataDirPaths = documentDefs.map((_) => withPrefix('data', _.name))
  await Promise.all([mkdir(withPrefix('types')), ...dataDirPaths.map(mkdir)])

  const writeFile = writeFileWithWrittenFilesCache({ writtenFilesCache })

  await Promise.all([
    writeFile({ filePath: withPrefix('package.json'), content: makePackageJson() }),
    writeFile({
      filePath: withPrefix('types', 'index.d.ts'),
      content: renderTypes({ schemaDef, generationOptions }),
    }),
    writeFile({ filePath: withPrefix('types', 'index.mjs'), content: makeHelperTypes() }),
    writeFile({ filePath: withPrefix('data', 'index.d.ts'), content: makeDataTypes({ schemaDef }) }),
    writeFile({ filePath: withPrefix('data', 'index.mjs'), content: makeIndexJs({ schemaDef }) }),
    ...dataBarrelFiles.map(writeFile),
    ...dataJsonFiles.map(writeFile),
  ])
}

const makePackageJson = (): string => {
  const packageJson: PackageJson & { typesVersions: any } = {
    name: 'dot-contentlayer',
    description: 'This package is auto-generated by Contentlayer',
    // TODO generate more meaningful version (e.g. by using Contentlayer version and schema hash)
    version: '0.0.0',
    exports: {
      './data': {
        import: './data/index.mjs',
      },
      './types': {
        import: './types/index.mjs',
      },
    },
    typesVersions: {
      '*': {
        data: ['./data'],
        types: ['./types'],
      },
    },
  }

  return JSON.stringify(packageJson, null, 2)
}

const mkdir = async (dirPath: string) => {
  try {
    await fsPromise.mkdir(dirPath, { recursive: true })
  } catch (e: any) {
    if (e.code !== 'EEXIST') {
      throw e
    }
  }
}

/**
 * Remembers which files already have been written to disk.
 * If no `documentHash` was provided, the writes won't be cached. */
const writeFileWithWrittenFilesCache =
  ({ writtenFilesCache }: { writtenFilesCache: WrittenFilesCache }) =>
  async ({
    filePath,
    content,
    documentHash,
  }: {
    filePath: string
    content: string
    documentHash?: string
  }): Promise<void> => {
    const fileIsUpToDate = documentHash !== undefined && writtenFilesCache[filePath] === documentHash
    if (fileIsUpToDate) {
      return
    }

    await fsPromise.writeFile(filePath, content, 'utf8')
    if (documentHash) {
      writtenFilesCache[filePath] = documentHash
    }
  }

const makeDataExportFile = ({ docDef, documentIds }: { docDef: DocumentTypeDef; documentIds: string[] }): string => {
  const dataVariableName = getDataVariableName({ docDef })

  if (docDef.isSingleton) {
    const documentId = documentIds[0]!
    return `\
// ${autogeneratedNote}
export { default as ${dataVariableName} } from './${docDef.name}/${idToFileName(documentId)}.json'
`
  }

  const makeVariableName = flow(idToFileName, (_) => camelCase(_, { stripRegexp: /[^A-Z0-9\_]/gi }))

  const docImports = documentIds
    .map((_) => `import ${makeVariableName(_)} from './${docDef.name}/${idToFileName(_)}.json'`)
    .join('\n')

  return `\
// ${autogeneratedNote}

${docImports}

export const ${dataVariableName} = [${documentIds.map((_) => makeVariableName(_)).join(', ')}]
`
}

const makeIndexJs = ({ schemaDef }: { schemaDef: SchemaDef }): string => {
  const dataVariableNames = Object.values(schemaDef.documentTypeDefMap).map(
    (docDef) => [docDef, getDataVariableName({ docDef })] as const,
  )
  const constReexports = dataVariableNames
    .map(([, dataVariableName]) => `export * from './${dataVariableName}.mjs'`)
    .join('\n')

  const constImportsForAllDocuments = dataVariableNames
    .map(([, dataVariableName]) => `import { ${dataVariableName} } from './${dataVariableName}.mjs'`)
    .join('\n')

  const allDocuments = dataVariableNames
    .map(([docDef, dataVariableName]) => (docDef.isSingleton ? dataVariableName : `...${dataVariableName}`))
    .join(', ')

  return `\
// ${autogeneratedNote}

export { isType } from 'contentlayer/client'

${constReexports}
${constImportsForAllDocuments}

export const allDocuments = [${allDocuments}]
`
}

const makeHelperTypes = (): string => {
  return `\
// ${autogeneratedNote}

export { isType } from 'contentlayer/client'
`
}

const makeDataTypes = ({ schemaDef }: { schemaDef: SchemaDef }): string => {
  const dataConsts = Object.values(schemaDef.documentTypeDefMap)
    .map((docDef) => [docDef, docDef.name, getDataVariableName({ docDef })] as const)
    .map(
      ([docDef, typeName, dataVariableName]) =>
        `export declare const ${dataVariableName}: ${typeName}${docDef.isSingleton ? '' : '[]'}`,
    )
    .join('\n')

  const documentTypeNames = Object.values(schemaDef.documentTypeDefMap)
    .map((docDef) => docDef.name)
    .join(', ')

  return `\
// ${autogeneratedNote}

import { ${documentTypeNames}, DocumentTypes } from '../types'

${dataConsts}

export declare const allDocuments: DocumentTypes[]

`
}

const getDataVariableName = ({ docDef }: { docDef: DocumentTypeDef }): string => {
  if (docDef.isSingleton) {
    return utils.lowercaseFirstChar(utils.inflection.singularize(docDef.name))
  } else {
    return 'all' + utils.uppercaseFirstChar(utils.inflection.pluralize(docDef.name))
  }
}

const idToFileName = (id: string): string => leftPadWithUnderscoreIfStartsWithNumber(id).replace(/\//g, '__')

const leftPadWithUnderscoreIfStartsWithNumber = (str: string): string => {
  if (/^[0-9]/.test(str)) {
    return '_' + str
  }
  return str
}

// const errorIfArtifactsDirIsDeleted = ({ artifactsDir }: { artifactsDir: string }) => {
//   watch(artifactsDir, async (event) => {
//     if (event === 'rename' && !(await fileOrDirExists(artifactsDir))) {
//       console.error(`Seems like the target directory (${artifactsDir}) was deleted. Please restart the command.`)
//       process.exit(1)
//     }
//   })
// }
