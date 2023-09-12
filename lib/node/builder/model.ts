export interface ComponentManifest {
    project?: string;
    name: string;
    fullname?: string;
    manifest_path?: string;
    registry_subdir?: string;
    deliverable?: boolean;
    depends_on?: string[];
    affected_by?: string[];
    description?: string;
    src?: string;
    builder?: string;
    docker?: {
        dockerfile?: string;
        path?: string;
        image_name: string;
        build_resource?: {
            cpu?: number;
            mem?: number;
        };
    };
    _circular_dep_checker: ComponentManifest[];
}

export interface ComponentManifestMap {
    [name: string]: ComponentManifest;
}

export interface ProjectManifest {
    name?: string;
    components: ComponentManifestMap;
}
