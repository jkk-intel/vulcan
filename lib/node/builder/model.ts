export interface ComponentManifest {
    project?: string;
    group?: boolean;
    name: string;
    name_safe?: string;
    name_hyphen?: string;
    fullname?: string;
    manifest_path?: string;
    registry_subdir?: string;
    publish?: boolean;
    depends_on?: string[];
    dir?: string;
    src?: string | string[];
    affected_by?: string[];
    ignore?: string[];
    info?: string
    builder?: 'docker' | 'shell';
    hash?: string;
    hash_long?: string;
    timeout?: number;
    no_cache?: boolean;
    no_prebuilt?: boolean;
    docker?: {
        context?: string;
        dockerfile?: string;
        image_name?: string;
        target?: string;
        debug?: boolean;
        build_args?: {[argname: string]: string}
        build_args_inherited?: {[argname: string]: string}
        build_args_temp?: {[argname: string]: string}
        build_resource?: {
            cpu?: number;
            mem?: number;
        };
        additionalRegistry?: DockerRegistryInfo
    };
    shell?: {
        build_script?: string
    }
    prebuild_script?: string
    postbuild_script?: string
    _circular_dep_checker: ComponentManifest[];
}

export type BuilderConfigChain = {
    chain: {
        file: string
        config: BuilderConfig
    }[]
    active?: TypedBuilderConfig
}

export type BuilderConfig = TypedBuilderConfig[]

export type TypedBuilderConfig = (BuilderConfigStandard)

export interface BuilderConfigStandard {
    type: 'standard'
    head_branch?: string
    base_branch?: string
    is_precommit?: boolean
    is_postcommit?: boolean
    multi_component?: boolean
    start_time?: number
    docker?: {
        remote_builders?: string[] 
        build_args?: {[argname: string]: string}
        registry?: DockerRegistryInfo
    }
}

type DockerRegistryInfo = {
    temp?: string | string[]
    cache?: string | string[]
    published?: {
        postcommit?: {
            publish?: boolean | 'ci-only'
            target?: string | string[]
        }
        precommit?: {
            publish?: boolean | 'ci-only'
            publish_latest?: boolean | 'ci-only'
            target?: string | string[]
        }
    }
}

export interface ComponentManifestMap {
    [name: string]: ComponentManifest;
}

export interface ProjectManifest {
    name?: string;
    components: ComponentManifestMap;
}
