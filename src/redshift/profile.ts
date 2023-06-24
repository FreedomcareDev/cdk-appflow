/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/
import { ICluster } from '@aws-cdk/aws-redshift-alpha';
import { Aws } from 'aws-cdk-lib';
import { CfnConnectorProfile } from 'aws-cdk-lib/aws-appflow';
import { Effect, IRole, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { RedshiftConnectorType } from './type';
import { S3Location } from '../core';
import { AppFlowPermissionsManager } from '../core/appflow-permissions-manager';
import { ConnectorProfileBase, ConnectorProfileProps } from '../core/connectors/connector-profile';

export interface RedshiftConnectorBasicCredentials {
  readonly username?: string;
  readonly password?: string;
}

export interface RedshiftConnectorProfileProps extends ConnectorProfileProps {
  readonly basicAuth: RedshiftConnectorBasicCredentials;
  /**
   * An intermediate location for the data retrieved from the flow source that will be further transferred to the Redshfit database
   */
  readonly intermediateLocation: S3Location;
  /**
   * The Redshift cluster to use this connector profile with
   */
  readonly cluster: ICluster;
  /**
   * An IAM Role that AppFlow will assume to interact with the Redshift cluster's Data API
   *
   * @default autogenerated IAM role
   */
  readonly dataApiRole?: IRole;
  /**
   * The name of the database which the RedshiftConnectorProfile will be working with
   */
  readonly databaseName: string;
  /**
   * An IAM Role that the Redshift cluster will assume to get data from the intermiediate S3 Bucket
   */
  readonly bucketAccessRole?: IRole;
}

export class RedshiftConnectorProfile extends ConnectorProfileBase {

  public static fromConnectionProfileArn(scope: Construct, id: string, arn: string) {
    return this._fromConnectorProfileAttributes(scope, id, { arn }) as RedshiftConnectorProfile;
  }

  public static fromConnectionProfileName(scope: Construct, id: string, name: string) {
    return this._fromConnectorProfileAttributes(scope, id, { name }) as RedshiftConnectorProfile;
  }

  /**
   * @internal
   */
  public readonly _location: S3Location;

  constructor(scope: Construct, id: string, props: RedshiftConnectorProfileProps) {
    super(scope, id, props, RedshiftConnectorType.instance);
    this.tryAddNodeDependency(this, props.cluster);
    this._location = props.intermediateLocation;
  }

  protected buildConnectorProfileProperties(
    props: ConnectorProfileProps,
  ): CfnConnectorProfile.ConnectorProfilePropertiesProperty {
    const properties = (props as RedshiftConnectorProfileProps);

    const redshiftAccessRole = properties.bucketAccessRole ?? this.buildRedshiftAccessRole(
      this.node.id,
      properties.cluster,
      properties.intermediateLocation);

    const appflowDataApiRole = properties.dataApiRole ?? this.buildAppFlowDataApiRole(
      this.node.id,
      properties.cluster,
      properties.databaseName,
      properties.basicAuth.username);

    this.tryAddNodeDependency(this, redshiftAccessRole);
    this.tryAddNodeDependency(this, appflowDataApiRole);
    this.tryAddNodeDependency(this, properties.intermediateLocation.bucket);
    AppFlowPermissionsManager.instance().grantBucketReadWrite(properties.intermediateLocation.bucket);

    return {
      redshift: {
        bucketName: properties.intermediateLocation.bucket.bucketName,
        bucketPrefix: properties.intermediateLocation.prefix,
        roleArn: redshiftAccessRole.roleArn,
        clusterIdentifier: properties.cluster.clusterName,
        databaseName: properties.databaseName,
        dataApiRoleArn: appflowDataApiRole.roleArn,
      },
    };
  }

  protected buildConnectorProfileCredentials(
    props: ConnectorProfileProps,
  ): CfnConnectorProfile.ConnectorProfileCredentialsProperty {
    const properties = (props as RedshiftConnectorProfileProps);
    return {
      redshift: properties && {
        username: properties.basicAuth.username,
        password: properties.basicAuth.password,
      },
    };
  }

  private buildRedshiftAccessRole(id: string, cluster: ICluster, location: S3Location): IRole {

    // see: https://docs.aws.amazon.com/appflow/latest/userguide/security_iam_service-role-policies.html#redshift-access-s3
    const role = new Role(this.stack, `${id}RedshiftRole`, {
      assumedBy: new ServicePrincipal('redshift.amazonaws.com'),
    });

    location.bucket.grantRead(role, location.prefix ? `${location.prefix}/*` : '*');

    const modifierId = `${id}RedshiftRoleAttach`;

    const modifier = new AwsCustomResource(this.stack, modifierId, {
      onCreate: {
        service: 'Redshift',
        action: 'modifyClusterIamRoles',
        parameters: {
          ClusterIdentifier: cluster.clusterName,
          AddIamRoles: [role.roleArn],
        },
        physicalResourceId: PhysicalResourceId.of(modifierId),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [role.roleArn],
          effect: Effect.ALLOW,
        }),
        new PolicyStatement({
          actions: ['redshift:ModifyClusterIamRoles'],
          resources: [
            `arn:${Aws.PARTITION}:redshift:${Aws.REGION}:${Aws.ACCOUNT_ID}:cluster:${cluster.clusterName}`,
          ],
          effect: Effect.ALLOW,
        }),
      ]),
    });

    this.node.addDependency(modifier);
    modifier.node.addDependency(cluster);

    return role;
  }

  private buildAppFlowDataApiRole(id: string, cluster: ICluster, databaseName: string, username?: string): IRole {
    // see: https://docs.aws.amazon.com/appflow/latest/userguide/security_iam_service-role-policies.html#access-redshift
    const role = new Role(this.stack, `${id}AppFlowDataApiRole`, {
      assumedBy: new ServicePrincipal('appflow.amazonaws.com'),
    });

    const policy = new Policy(this.stack, `${id}AppFlowDataApiRolePolicy`, {
      roles: [role],
      statements: [
        new PolicyStatement({
          sid: 'DataAPIPermissions',
          effect: Effect.ALLOW,
          actions: [
            'redshift-data:ExecuteStatement',
            'redshift-data:GetStatementResult',
            'redshift-data:DescribeStatement',
          ],
          resources: ['*'],
        }),
        new PolicyStatement({
          sid: 'GetCredentialsForAPIUser',
          effect: Effect.ALLOW,
          actions: ['redshift:GetClusterCredentials'],
          resources: [
            `arn:aws:redshift:${Aws.REGION}:${Aws.ACCOUNT_ID}:dbname:${cluster.clusterName}/${databaseName}`,
            `arn:aws:redshift:${Aws.REGION}:${Aws.ACCOUNT_ID}:dbuser:${cluster.clusterName}/${username ?? '*'}`,
          ],
        }),
        new PolicyStatement({
          sid: 'DenyCreateAPIUser',
          effect: Effect.DENY,
          actions: ['redshift:CreateClusterUser'],
          resources: [
            `arn:aws:redshift:${Aws.REGION}:${Aws.ACCOUNT_ID}:dbuser:${cluster.clusterName}/*`,
          ],
        }),
        new PolicyStatement({
          sid: 'ServiceLinkedRole',
          effect: Effect.ALLOW,
          actions: ['iam:CreateServiceLinkedRole'],
          resources: [
            `arn:aws:iam::${Aws.ACCOUNT_ID}:role/aws-service-role/redshift-data.amazonaws.com/AWSServiceRoleForRedshift`,
          ],
          conditions: {
            StringLike: {
              'iam:AWSServiceName': 'redshift-data.amazonaws.com',
            },
          },
        }),
      ],
    });

    this.tryAddNodeDependency(this, policy);

    return role;
  }
}