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
    builder?: 'docker' | 'shell' | 'nobuild';
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
        no_pull?: boolean;
        build_args?: {[argname: string]: string}
        build_args_inherited?: {[argname: string]: string}
        build_args_temp?: {[argname: string]: string}
        cache_config?: DockerCacheToConfig
        build_resource?: {
            cpu?: number;
            mem?: number;
        };
        additional?: {
            tags?: {
                temp?: string | string[]
                precommit?: string | string[]
                postcommit?: string | string[]
            }
        }
    };
    shell?: {
        build_script?: string
    }
    outputs?: {
        docker_images?: string[] 
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
        task_assign?: {
            type?: 'builder-pool' | 'coordinator'
            strategy?: 'roundrobin' | 'random'
            coordinatorEndpoint?: string
            builder_pool?: string[]
        }
        build_args?: {[argname: string]: string}
        cache_config?: DockerCacheToConfig
        registry?: DockerRegistryInfo
    }
}

type DockerCacheToConfig = {
    /**
     * zstd compression-level (compress speed & ratio):
     *  - level 1: 750MB/s, 37%
     *  - level 7: 350MB/s, 33%
     *  - 1level 15: 60MB/s, 32%
     *  
     *  ...
     * */
    compression_level?: 1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22
    mode?: 'min' | 'max'
}

type DockerRegistryInfo = {
    temp?: string | string[]
    cache?: string | string[]
    published?: {
        precommit?: {
            publish?: boolean | 'ci-only'
            target?: string | string[]
        }
        postcommit?: {
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
